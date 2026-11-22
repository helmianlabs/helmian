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
// Delivery semantics: at-most-once per row between live drainers. A drain
// claims its batch with SELECT ... FOR UPDATE SKIP LOCKED and HOLDS that
// transaction open across delivery and settle: the row locks are the claim,
// so a concurrent drainer's claim skips every row this drain holds, and the
// settle (status update guarded by status='queued') commits together with
// the claim. An earlier shape committed the claim before delivering, which
// dropped the locks and let two drainers deliver the same row; the locks
// only exclude while the claiming transaction is still open. If a drain
// dies mid-delivery its transaction rolls back and the rows stay queued,
// so a crash can re-deliver but a live peer cannot double-deliver. Attempts
// are capped at 3; a message for a provider with no webhook URL configured
// fails immediately with reason webhook_not_configured and is never
// retried. Every send and every terminal failure is audit-logged inside
// the settle, behind a savepoint: a failed audit write rolls back to the
// savepoint only, so it never un-sends a delivered message and never
// discards the status update it rides with.
//
// Per-tenant routing (Bite F): when the worker is constructed with a
// destination resolver (directly, or built from a credential client),
// the deliver path changes and nothing else does. The claimed batch is
// grouped by (tenant_id, provider), each group is resolved ONCE per
// drain through src/cloud/connector-destinations.mjs, and each group is
// delivered to its own tenant's stored webhook; the operator tenant
// alone may fall back to the server-wide env webhooks above. A tenant
// with no destination fails its rows on the first drain with reason
// tenant_destination_not_configured, audited exactly like
// webhook_not_configured. This is the addendum to sql/052's header,
// which says webhook URLs live only in server env: that rule named the
// outbox table (it still stores none); a tenant's own URL is a tenant
// secret and lives in the credential vault. A worker constructed with
// no resolver keeps the historical env behaviour above, byte for byte.

import { randomUUID } from 'node:crypto';
import { postConnectorMessage } from '../cloud/communication-connectors.mjs';
import { resolveOutboundDestination } from '../cloud/connector-destinations.mjs';
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
  // The audit schema (sql/004) permits only the membership roles
  // (owner, admin, member, auditor): there is no 'worker' role, and an
  // audit insert carrying one is rejected by the
  // audit_events_actor_role_check constraint. System actors in this
  // codebase write audit events under the membership-shaped role
  // 'member' (tenant-action-policy.mjs's system actor;
  // credential-vault.mjs's transactionContext; workspace-lease.mjs's
  // workerContext), with the true actor named in actorSubject. The
  // worker id stays the subject here, for the same reason.
  return { tenantId, actorSubject: workerId, actorRole: 'member', sessionId: randomUUID(), requestId: randomUUID() };
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

export function createConnectorOutboundWorker({ pool, workerId = 'worker:cloud-connector-outbound', batchSize = 10, log = () => {}, env = process.env, postMessage = postConnectorMessage, credentials = null, resolveDestination = null, gate = null } = {}) {
  if (!pool?.connect) throw new Error('connector outbound worker needs a Postgres pool');
  if (!WORKER_ID_PATTERN.test(workerId)) throw new Error('connector outbound worker id is invalid');
  const limit = Math.min(Math.max(Number(batchSize) || 10, 1), 50);
  // Bite F: the destination resolver this worker consults per claimed
  // group. An injected resolver wins; otherwise one is built from the
  // credential client, resolving under this worker's own audit context
  // (workerContext below) in the tenant-pair precedent's shape. With
  // neither, the worker delivers exactly as it did before Bite F.
  const destinationResolver = typeof resolveDestination === 'function'
    ? resolveDestination
    : (credentials && typeof credentials.resolveVaultCredential === 'function'
      ? ({ tenantId, provider }) => resolveOutboundDestination({ credentials, tenantId, provider, env, actorContext: workerContext(tenantId, workerId) })
      : null);

  // settle runs INSIDE the claiming transaction (see the header): the
  // status update and the claim commit or roll back together, and the
  // audit insert rides behind a savepoint so its failure discards only
  // itself, never the status update.
  async function settle(client, message, outcome) {
    // outcome: { status: 'sent'|'failed', attempts, receipt }
    const updated = await client.query(
      `update helmion.connector_outbound_messages
       set status = $2, attempts = $3, receipt = $4::jsonb, updated_at = clock_timestamp()
       where id = $1 and status = 'queued'`,
      [message.id, outcome.status, outcome.attempts, JSON.stringify({ format: CONNECTOR_OUTBOUND_WORKER_FORMAT, ...outcome.receipt })],
    );
    if (updated.rowCount === 1) {
      await client.query('savepoint outbound_audit');
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
        await client.query('release savepoint outbound_audit');
      } catch (auditError) {
        // A failed audit write never un-sends a delivered message, and
        // the savepoint keeps it from discarding the status update.
        await client.query('rollback to savepoint outbound_audit').catch(() => {});
        await client.query('release savepoint outbound_audit').catch(() => {});
        log(`connector outbound audit failed: ${auditError.message}`);
      }
    }
    return updated.rowCount === 1;
  }

  // One delivery attempt and its settle: shared by the historical env
  // road and the Bite F per-tenant road, so the attempt counting, the
  // terminal failure, and the receipts are identical on both.
  async function attemptDelivery(client, message, post) {
    try {
      const result = await post();
      return settle(client, message, { status: 'sent', attempts: message.attempts, receipt: { reason: 'delivered', delivered: result.delivered, httpStatus: result.status } });
    } catch (error) {
      const attempts = Number(message.attempts || 0) + 1;
      if (attempts >= CONNECTOR_OUTBOUND_MAX_ATTEMPTS) {
        return settle(client, message, { status: 'failed', attempts, receipt: { reason: 'delivery_failed', error: String(error?.message ?? error).slice(0, 300) } });
      }
      // Leave queued for the next drain; record the attempt count in the
      // claiming transaction, so it commits with the claim.
      await client.query(`update helmion.connector_outbound_messages set attempts = $2, updated_at = clock_timestamp() where id = $1 and status = 'queued'`, [message.id, attempts]);
      return false;
    }
  }

  // The attribute-policy gate for outbound network requests. When a gate
  // is supplied, every delivery is authorized BEFORE the request leaves:
  // the tenant's own panel rules can deny a destination domain, and the
  // verdict's receipt is already in the audit trail either way. A denial
  // settles the message failed with the policy reason — the request is
  // never sent. With no gate supplied the worker behaves as before.
  async function gateAllows(client, message, webhookUrl) {
    if (!gate) return true;
    let domain = null;
    try { domain = webhookUrl ? new URL(webhookUrl).hostname : null; } catch { domain = null; }
    const verdict = await gate.authorizeNetworkRequest(
      { tenantId: message.tenant_id, subject: workerId, role: 'system' },
      { domain, dataLabel: message.provider ?? null },
    );
    if (verdict.allowed) return true;
    log('connector outbound refused by attribute policy', { messageId: message.id, domain, receiptId: verdict.receiptId });
    return settle(client, message, { status: 'failed', attempts: CONNECTOR_OUTBOUND_MAX_ATTEMPTS, receipt: { reason: 'attribute_policy_denied', provider: message.provider, domain, gateReceiptId: verdict.receiptId, matchedRuleIds: verdict.matchedRuleIds } });
  }

  async function deliver(client, message) {
    const webhookUrl = webhookUrlFor(message.provider, env);
    if (!webhookUrl) {
      return settle(client, message, { status: 'failed', attempts: CONNECTOR_OUTBOUND_MAX_ATTEMPTS, receipt: { reason: 'webhook_not_configured', provider: message.provider } });
    }
    const gated = await gateAllows(client, message, webhookUrl);
    if (gated !== true) return gated;
    return attemptDelivery(client, message, () => postMessage({ provider: message.provider, text: message.text, env }));
  }

  // Bite F: deliver one row to its tenant group's resolved destination.
  // A group with no destination (or a resolver answer with no usable
  // URL) fails terminally on this drain, mirroring webhook_not_configured
  // exactly; no delivery is attempted for such a row.
  async function deliverToDestination(client, message, destination) {
    const webhookUrl = destination && (destination.kind === 'tenant' || destination.kind === 'operator-env')
      ? String(destination.webhookUrl ?? '').trim()
      : '';
    if (!webhookUrl) {
      return settle(client, message, { status: 'failed', attempts: CONNECTOR_OUTBOUND_MAX_ATTEMPTS, receipt: { reason: 'tenant_destination_not_configured', provider: message.provider } });
    }
    const gated = await gateAllows(client, message, webhookUrl);
    if (gated !== true) return gated;
    return attemptDelivery(client, message, () => postMessage({ provider: message.provider, text: message.text, env, webhookUrl }));
  }

  async function runOnce() {
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
      // The claiming transaction stays open across delivery and settle:
      // its row locks are what stop a concurrent drainer from taking
      // the same rows. It commits only when every settle in the batch
      // is written, and rolls back whole if the drain itself fails.
      const processed = [];
      if (destinationResolver) {
        // Bite F: group the claimed batch by (tenant_id, provider) and
        // resolve each group once for the whole drain. A resolution
        // error is confined to its own group: those rows are left
        // untouched, so their locks release at commit with no writes
        // and they stay queued for the next drain, exactly as a crash
        // mid-batch would leave them; every other group proceeds.
        const groups = new Map();
        for (const message of claimed.rows) {
          const key = `${message.tenant_id} ${message.provider}`;
          let group = groups.get(key);
          if (!group) { group = []; groups.set(key, group); }
          group.push(message);
        }
        for (const group of groups.values()) {
          const { tenant_id: tenantId, provider } = group[0];
          let destination;
          try {
            destination = await destinationResolver({ tenantId, provider });
          } catch (error) {
            log(`connector outbound destination resolution failed for tenant ${tenantId} (${provider}): ${error.message}`);
            continue;
          }
          for (const message of group) {
            const settled = await deliverToDestination(client, message, destination);
            if (settled) processed.push({ messageId: message.id, provider: message.provider });
          }
        }
      } else {
        for (const message of claimed.rows) {
          const settled = await deliver(client, message);
          if (settled) processed.push({ messageId: message.id, provider: message.provider });
        }
      }
      await client.query('commit');
      for (const p of processed) log(`connector outbound ${p.messageId} -> ${p.provider} settled`);
      return processed;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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
