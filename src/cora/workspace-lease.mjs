// Workspace write leases: mutual exclusion for cloud workers that hand work to
// the desktop runner. Fail-closed by design:
//   - acquire only if no unexpired ACTIVE lease exists for the scope;
//   - a stale (expired) lease may be taken over, kept as history;
//   - on any error or ambiguity the lease is treated as HELD — never default
//     to free (the desktop rule "UNREADABLE is never shown as NONE" applies).
// Scope: a project_key, or NULL for tenant scope (work items with no project
// of their own, e.g. artifact execution requests). project_key is never
// path-shaped: slashes, backslashes, drive letters, and ".." are rejected.
// Acquire and release are both audit-logged.

import { randomUUID } from 'node:crypto';
import { appendAuditEvent } from '../cloud/audit-event-repository.mjs';

const PROJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,95}$/;
const HOLDER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const TOKEN_PATTERN = /^[0-9a-f-]{36}$/;

function leaseScope(projectKey) {
  if (projectKey == null || projectKey === '') return null;
  const key = String(projectKey).trim().toLowerCase();
  if (!PROJECT_KEY_PATTERN.test(key) || key.includes('..') || /^[a-z]:/.test(key)) {
    throw new Error('workspace lease project key is invalid');
  }
  return key;
}

function workerContext(tenantId, holder) {
  return { tenantId, actorSubject: holder, actorRole: 'worker', sessionId: randomUUID(), requestId: randomUUID() };
}

export async function acquireWorkspaceLease({ pool, tenantId, projectKey = null, holder, ttlMs = 60000 } = {}) {
  if (!pool?.connect) throw new Error('workspace lease needs a Postgres pool');
  const tenant = String(tenantId ?? '').trim();
  const scope = leaseScope(projectKey);
  const who = String(holder ?? '').trim();
  if (!tenant || !HOLDER_PATTERN.test(who)) throw new Error('workspace lease acquire input is invalid');
  const ttl = Math.min(Math.max(Number(ttlMs) || 60000, 1000), 3600000);
  const token = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Fail-closed read: lock the scope's lease rows so concurrent acquirers serialize.
    const existing = await client.query(
      `select id, lease_token, holder, status, expires_at from helmion.workspace_write_leases
       where tenant_id=$1 and ${scope === null ? 'project_key is null' : 'project_key=$2'} and status='ACTIVE'
       order by acquired_at desc limit 1 for update`,
      scope === null ? [tenant] : [tenant, scope],
    );
    const current = existing.rows[0] ?? null;
    if (current && new Date(current.expires_at) > new Date()) {
      await client.query('rollback');
      return { acquired: false, reason: 'held', holder: current.holder };
    }
    let tookOverFrom = null;
    if (current) {
      // Stale lease: mark expired, keep as history.
      tookOverFrom = current.holder;
      await client.query(
        `update helmion.workspace_write_leases set status='EXPIRED', closed_at=clock_timestamp(), close_reason='takeover' where id=$1`,
        [current.id],
      );
    }
    const expiresAt = new Date(Date.now() + ttl).toISOString();
    try {
      await client.query(
        `insert into helmion.workspace_write_leases (tenant_id, project_key, holder, lease_token, expires_at)
         values ($1,$2,$3,$4,$5)`,
        [tenant, scope, who, token, expiresAt],
      );
    } catch (error) {
      // Lost the race, or the table is not there yet: fail closed.
      await client.query('rollback');
      if (error?.code === '42P01') return { acquired: false, reason: 'unavailable' };
      return { acquired: false, reason: 'conflict' };
    }
    await appendAuditEvent(client, workerContext(tenant, who), {
      actionType: 'workspace.lease.acquired',
      canonicalTarget: { resource: 'workspace_write_lease', projectKey: scope, leaseToken: token },
      policyVersion: 'workspace-lease.v1',
      decision: 'ALLOW',
      privacySummary: 'Worker acquired the workspace write lease for the desktop handoff',
      result: { projectKey: scope, holder: who, tookOverFrom },
    });
    await client.query('commit');
    return { acquired: true, leaseToken: token, projectKey: scope };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    // Any ambiguity: treat as locked. Missing table is reported distinctly.
    if (error?.code === '42P01') return { acquired: false, reason: 'unavailable' };
    return { acquired: false, reason: 'error' };
  } finally {
    client.release();
  }
}

export async function releaseWorkspaceLease({ pool, tenantId, projectKey = null, leaseToken } = {}) {
  if (!pool?.connect) throw new Error('workspace lease needs a Postgres pool');
  const tenant = String(tenantId ?? '').trim();
  const scope = leaseScope(projectKey);
  const token = String(leaseToken ?? '').trim();
  if (!tenant || !TOKEN_PATTERN.test(token)) throw new Error('workspace lease release input is invalid');
  const client = await pool.connect();
  try {
    await client.query('begin');
    // The token is the capability: only the token holder can release.
    const existing = await client.query(
      `select id, holder, status from helmion.workspace_write_leases
       where tenant_id=$1 and lease_token=$2 and ${scope === null ? 'project_key is null' : 'project_key=$3'} for update`,
      scope === null ? [tenant, token] : [tenant, token, scope],
    );
    const lease = existing.rows[0] ?? null;
    if (!lease || lease.status !== 'ACTIVE') {
      await client.query('rollback');
      return { released: false, reason: 'not_found' };
    }
    await client.query(
      `update helmion.workspace_write_leases set status='RELEASED', closed_at=clock_timestamp(), close_reason='released by holder' where id=$1`,
      [lease.id],
    );
    await appendAuditEvent(client, workerContext(tenant, lease.holder), {
      actionType: 'workspace.lease.released',
      canonicalTarget: { resource: 'workspace_write_lease', projectKey: scope, leaseToken: token },
      policyVersion: 'workspace-lease.v1',
      decision: 'ALLOW',
      privacySummary: 'Worker released the workspace write lease',
      result: { projectKey: scope },
    });
    await client.query('commit');
    return { released: true };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    if (error?.code === '42P01') return { released: false, reason: 'unavailable' };
    throw error;
  } finally {
    client.release();
  }
}
