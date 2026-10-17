// Connector outbound worker: drains helmion.connector_outbound_messages and
// delivers them to Discord/Slack via postConnectorMessage
// (src/cloud/communication-connectors.mjs: host-allowlisted webhook URLs,
// 10s timeout). Drain-on-read, serverless-safe, following the
// artifact-execution worker pattern.
//
// enqueueConnectorMessage is the shared helper used by server code (approval
// decide(), critical Guard findings, worker run completions, the /admin test
// button). It is 42P01-safe: if migration 052 is not applied yet the enqueue
// is a no-op that reports { queued: false, reason: 'unavailable' } instead of
// throwing. Input validation still throws.
//
// Delivery semantics: at-most-once per row. Rows are claimed with
// SELECT ... FOR UPDATE SKIP LOCKED and the status update is guarded by
// status='queued', so a concurrent drainer cannot double-deliver. Attempts are
// capped at 3; a message for a provider with no webhook URL configured fails
// immediately with reason webhook_not_configured and is never retried. Every
// send and every terminal failure is audit-logged (best-effort: a failed
// audit write never un-sends a delivered message).

import { randomUUID } from 'node:crypto';
import { postConnectorMessage } from '../cloud/communication-connectors.mjs';
import { appendAuditEvent } from '../cloud/audit-event-repository.mjs';

export const CONNECTOR_OUTBOUND_WORKER_FORMAT = 'helmian.connector-outbound.v1';
export const CONNECTOR_OUTBOUND_MAX_ATTEMPTS = 3;
const WORKER_ID_PATTERN = /^worker:[a-z0-9][a-z0-9._:-]{0,95}$/;
const PROVIDERS = new Set(['discord', 'slack']);
const PROVIDER_PATTERN = /^[a-z]{1,16}$/;
const CHANNEL_LABEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function webhookUrlFor(provider, env = process.env) {
  const key = provider === 'discord' ? 'HELMION_DISCORD_WEBHOOK_URL' : 'HELMION_SLACK_WEBHOOK_URL';
  return String(env?.[key] ?? '').trim();
}

function workerContext(tenantId, workerId) {
  return { tenantId, actorSubject: workerId, actorRole: 'worker', sessionId: randomUUID(), requestId: randomUUID() };
}

export async function enqueueConnectorMessage({ pool, tenantId, provider, channelLabel = null, text } = {}) {
  if (!pool?.connect) throw new Error('connector outbox enqueue needs a Postgres pool');
  const tenant = String(tenantId ?? '').trim();
  const normalizedProvider = String(provider ?? '').trim().toLowerCase();
  const label = channelLabel == null || channelLabel === '' ? null : String(channelLabel).trim();
  const body = String(text ?? '').trim();
  if (!tenant) throw new Error('connector outbox enqueue needs a tenant id');
  if (!PROVIDER_PATTERN.test(normalizedProvider) || !PROVIDERS.has(normalizedProvider)) throw new Error('connector outbox provider is unsupported');
  if (label != null && !CHANNEL_LABEL_PATTERN.test(label)) throw new Error('connector outbox channel label is invalid');
  if (!body || body.length > 4000) throw new Error('connector outbox text is missing or too long');
  const client = await pool.connect();
  try {
    const inserted = await client.query(
      `insert into helmion.connector_outbound_messages (tenant_id, provider, channel_label, text)
       values ($1,$2,$3,$4) returning id`,
      [tenant, normalizedProvider, label, body],
    );
    return { queued: true, messageId: inserted.rows[0].id };
  } catch (error) {
    // Migration 052 not applied yet: the outbox does not exist. No-op.
    if (error?.code === '42P01') return { queued: false, reason: 'unavailable' };
    throw error;
  } finally {
    client.release();
  }
}

export function createConnectorOutboundWorker({ pool, workerId = 'worker:cloud-connector-outbound', batchSize = 10, log = () => {}, env = process.env, postMessage = postConnectorMessage } = {}) {
  if (!pool?.connect) throw new Error('connector outbound worker needs a Postgres pool');
  if (!WORKER_ID_PATTERN.test(workerId)) throw new Error('connector outbound worker id is invalid');
  const limit = Math.min(Math.max(Number(batchSize) || 10, 1), 50);

  async function claimBatch() {
    const client = await pool.connect();
    try {
      await client.query('begin');
      let claimed;
      try {
        claimed = await client.query(
          `select id, tenant_id, provider, channel_label, text, attempts
           from helmion.connector_outbound_messages
           where status = 'queued' and attempts < $1
           order by created_at, id limit $2 for update skip locked`,
          [CONNECTOR_OUTBOUND_MAX_ATTEMPTS, limit],
        );
      } catch (error) {
        // Migration 052 not applied yet: nothing to drain.
        await client.query('rollback').catch(() => {});
        if (error?.code === '42P01') return [];
        throw error;
      }
      await client.query('commit');
      return claimed.rows;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function settle(message, outcome) {
    // outcome: { status: 'sent'|'failed', attempts, receipt }
    const client = await pool.connect();
    try {
      await client.query('begin');
      const updated = await client.query(
        `update helmion.connector_outbound_messages
         set status = $2, attempts = $3, receipt = $4::jsonb, updated_at = clock_timestamp()
         where id = $1 and status = 'queued'`,
        [message.id, outcome.status, outcome.attempts, JSON.stringify({ format: CONNECTOR_OUTBOUND_WORKER_FORMAT, ...outcome.receipt })],
      );
      if (updated.rowCount === 1) {
        try {
          await appendAuditEvent(client, workerContext(message.tenant_id, workerId), {
            actionType: outcome.status === 'sent' ? 'connector.outbound.sent' : 'connector.outbound.failed',
            canonicalTarget: { resource: 'connector_outbound_message', messageId: message.id, provider: message.provider, channelLabel: message.channel_label },
            policyVersion: 'connector-outbound.v1',
            decision: outcome.status === 'sent' ? 'ALLOW' : 'DENY',
            privacySummary: outcome.status === 'sent'
              ? `Delivered a ${message.provider} message (${message.channel_label ?? 'no label'})`
              : `Failed to deliver a ${message.provider} message (${message.channel_label ?? 'no label'}): ${outcome.receipt.reason ?? 'unknown'}`,
            result: { status: outcome.status, attempts: outcome.attempts, receipt: outcome.receipt },
          });
        } catch (auditError) {
          // A failed audit write never un-sends a delivered message.
          log(`connector outbound audit failed: ${auditError.message}`);
        }
      }
      await client.query('commit');
      return updated.rowCount === 1;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function deliver(message) {
    if (!webhookUrlFor(message.provider, env)) {
      return settle(message, { status: 'failed', attempts: CONNECTOR_OUTBOUND_MAX_ATTEMPTS, receipt: { reason: 'webhook_not_configured', provider: message.provider } });
    }
    try {
      const result = await postMessage({ provider: message.provider, text: message.text, env });
      return settle(message, { status: 'sent', attempts: message.attempts, receipt: { reason: 'delivered', delivered: result.delivered, httpStatus: result.status } });
    } catch (error) {
      const attempts = Number(message.attempts || 0) + 1;
      if (attempts >= CONNECTOR_OUTBOUND_MAX_ATTEMPTS) {
        return settle(message, { status: 'failed', attempts, receipt: { reason: 'delivery_failed', error: String(error?.message ?? error).slice(0, 300) } });
      }
      // Leave queued for the next drain; record the attempt count.
      const client = await pool.connect();
      try {
        await client.query(`update helmion.connector_outbound_messages set attempts = $2, updated_at = clock_timestamp() where id = $1 and status = 'queued'`, [message.id, attempts]);
      } finally {
        client.release();
      }
      return false;
    }
  }

  async function runOnce() {
    const claimed = await claimBatch();
    if (claimed.length === 0) return [];
    const processed = [];
    for (const message of claimed) {
      try {
        const settled = await deliver(message);
        if (settled) processed.push({ messageId: message.id, provider: message.provider });
      } catch (error) {
        log(`connector outbound delivery error for message ${message.id}: ${error.message}`);
      }
    }
    for (const p of processed) log(`connector outbound ${p.messageId} -> ${p.provider} settled`);
    return processed;
  }

  function start({ intervalMs = 5000 } = {}) {
    let timer = null;
    let stopped = false;
    const tick = async () => {
      try { await runOnce(); } catch (error) { log(`connector outbound worker error: ${error.message}`); }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, 0);
    return { stop() { stopped = true; clearTimeout(timer); } };
  }

  return Object.freeze({ runOnce, start });
}
