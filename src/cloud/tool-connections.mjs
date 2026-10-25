// Tool connections: the store over helmion.tool_connections (sql/061) —
// the registry that says whether an agent can actually CALL a service's
// tools, per (tenant, scope, service). Design: research note
// helmian-connectors-2026-10-25 §4.
//
// THE HONESTY RULE, enforced here in code, not by convention:
//   - register() writes intent only. It REFUSES any caller-supplied state.
//   - The ONLY writer of state='verified' is recordProbeReceipt(), which
//     demands a probe receipt (method + tool count) and stamps
//     last_verified_at from the database clock.
//   - recordProbeFailure() sets state='failed', keeps the error, and CLEARS
//     the verified receipt (last_verified_at / last_tools_count), so a
//     connection that stops answering cannot keep an old "verified".
//   - There is deliberately no generic update/setState method.
// Surfaces (bite 1b) render "Connected / Works" only from a row this store
// returns with state='verified' and a fresh last_verified_at
// (see isVerifiedFresh).
//
// REFERENCES ONLY: server_ref names a server (plugin + registration name,
// endpoint URL, or config target); credential_reference points at where a
// credential lives (vault reference or token-source declaration). A
// credential VALUE is never accepted here, let alone stored — the probe
// resolves it at probe time (src/agent/tool-connection-probe.mjs).

export const TOOL_CONNECTION_SCOPE_KINDS = Object.freeze(['workspace', 'agent']);
export const TOOL_CONNECTION_KINDS = Object.freeze(['mcp-stdio', 'mcp-http', 'native']);
export const TOOL_CONNECTION_STATES = Object.freeze(['registered', 'probing', 'verified', 'failed', 'revoked']);
export const PROBE_METHOD_TOOLS_LIST = 'tools/list';

const MAX_ERROR_CHARS = 2000;

// Keys that would mean the caller is handing us a credential VALUE instead
// of a reference. Any of these on a credential_reference is refused.
const CREDENTIAL_VALUE_KEYS = Object.freeze(['value', 'token', 'secret', 'password', 'apiKey', 'api_key', 'credential']);

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function isMissingTable(error) {
  return error?.code === '42P01';
}

export function validateCredentialReference(reference) {
  if (reference === null || reference === undefined) return null;
  if (typeof reference !== 'object' || Array.isArray(reference)) {
    throw badRequest('credential_reference must be a reference object (a vault reference or a token-source declaration), never a credential value');
  }
  for (const key of CREDENTIAL_VALUE_KEYS) {
    if (key in reference) {
      throw badRequest(`credential_reference carries "${key}" — references point at a credential, they never hold one`);
    }
  }
  if (reference.type === 'vault') {
    if (typeof reference.ref !== 'string' || !reference.ref.trim()) {
      throw badRequest('a vault credential_reference needs a non-empty "ref" pointer');
    }
    return { type: 'vault', ref: reference.ref.trim() };
  }
  if (reference.type === 'token-source') {
    const source = reference.source;
    if (!source || typeof source !== 'object') {
      throw badRequest('a token-source credential_reference needs a "source" declaration');
    }
    if (source.kind === 'env') {
      if (typeof source.name !== 'string' || !source.name.trim()) {
        throw badRequest('an env token source needs the variable "name"');
      }
      return { type: 'token-source', source: { kind: 'env', name: source.name.trim() } };
    }
    if (source.kind === 'file') {
      if (typeof source.path !== 'string' || !source.path.trim()) {
        throw badRequest('a file token source needs the file "path"');
      }
      const out = { kind: 'file', path: source.path.trim() };
      if (source.field !== undefined && source.field !== null) {
        if (typeof source.field !== 'string' || !source.field.trim()) {
          throw badRequest('a file token source "field" must be a non-empty string when given');
        }
        out.field = source.field.trim();
      }
      return { type: 'token-source', source: out };
    }
    throw badRequest('a token source kind must be "env" or "file"');
  }
  throw badRequest('credential_reference type must be "vault" or "token-source"');
}

function validateServerRef(serverRef) {
  if (typeof serverRef !== 'string' || !serverRef.trim()) {
    throw badRequest('server_ref is required: a plugin + registration name, an endpoint URL, or a config target — never a secret');
  }
  const ref = serverRef.trim();
  // An endpoint URL must not smuggle credentials in its userinfo.
  try {
    const url = new URL(ref);
    if (url.username || url.password) {
      throw badRequest('server_ref must not carry credentials in the URL — point credential_reference at the vault instead');
    }
  } catch (error) {
    if (error?.status === 400) throw error;
    // Not a URL: a plugin/config reference, which is fine as-is.
  }
  return ref;
}

function rowOf(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    serviceId: row.service_id,
    kind: row.kind,
    serverRef: row.server_ref,
    credentialReference: row.credential_reference ?? null,
    accountLabel: row.account_label ?? null,
    grantedScopes: Array.isArray(row.granted_scopes) ? row.granted_scopes : [],
    state: row.state,
    lastVerifiedAt: row.last_verified_at ?? null,
    probeMethod: row.probe_method ?? null,
    lastToolsCount: row.last_tools_count ?? null,
    lastError: row.last_error ?? null,
    updatedBySubject: row.updated_by_subject,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function keyParams(key = {}) {
  const scopeKind = String(key.scopeKind ?? '');
  const scopeId = String(key.scopeId ?? '');
  const serviceId = String(key.serviceId ?? '');
  if (!TOOL_CONNECTION_SCOPE_KINDS.includes(scopeKind)) throw badRequest('scope_kind must be "workspace" or "agent"');
  if (!scopeId) throw badRequest('scope_id is required');
  if (!serviceId) throw badRequest('service_id is required');
  return [scopeKind, scopeId, serviceId];
}

/**
 * The freshness rule bite 1b's surfaces render by: "verified" only counts
 * while its receipt is fresh. Pure, so every surface computes it the same.
 */
export function isVerifiedFresh(row, { now = Date.now(), maxAgeMs } = {}) {
  if (!row || row.state !== 'verified' || !row.lastVerifiedAt) return false;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw badRequest('isVerifiedFresh needs a positive maxAgeMs');
  const verifiedMs = new Date(row.lastVerifiedAt).getTime();
  if (!Number.isFinite(verifiedMs)) return false;
  return now - verifiedMs <= maxAgeMs && verifiedMs <= now;
}

export function createToolConnectionsStore(pool) {
  const withTenant = async (tenantId, fn) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('helmion.tenant_id', $1, true)`, [tenantId]);
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  };

  const whereKey = `tenant_id = current_setting('helmion.tenant_id', true)
    and scope_kind = $1 and scope_id = $2 and service_id = $3`;

  return {
    /**
     * Register intent. State always lands as 'registered' — a caller who
     * passes a state (above all 'verified') is refused outright: verified
     * is a probe's receipt, never a registration field.
     */
    async register(tenantId, subject, input = {}) {
      if (!subject || typeof subject !== 'string') throw badRequest('updated_by_subject is required');
      if ('state' in input) {
        throw badRequest('state cannot be set at registration — a connection becomes verified only when a probe writes its receipt');
      }
      const [scopeKind, scopeId, serviceId] = keyParams(input);
      if (!TOOL_CONNECTION_KINDS.includes(input.kind)) {
        throw badRequest(`kind must be one of ${TOOL_CONNECTION_KINDS.join(', ')}`);
      }
      const serverRef = validateServerRef(input.serverRef);
      const credentialReference = validateCredentialReference(input.credentialReference ?? null);
      const grantedScopes = input.grantedScopes ?? [];
      if (!Array.isArray(grantedScopes) || grantedScopes.some((s) => typeof s !== 'string')) {
        throw badRequest('granted_scopes must be an array of scope names');
      }
      const accountLabel = input.accountLabel ?? null;
      if (accountLabel !== null && (typeof accountLabel !== 'string' || !accountLabel.trim())) {
        throw badRequest('account_label must be a non-empty string when given');
      }
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `insert into helmion.tool_connections
               (tenant_id, scope_kind, scope_id, service_id, kind, server_ref,
                credential_reference, account_label, granted_scopes, state, updated_by_subject)
             values (current_setting('helmion.tenant_id', true), $1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, 'registered', $9)
             on conflict (tenant_id, scope_kind, scope_id, service_id)
             do update set kind = excluded.kind, server_ref = excluded.server_ref,
                credential_reference = excluded.credential_reference,
                account_label = excluded.account_label, granted_scopes = excluded.granted_scopes,
                -- A changed kind/server_ref describes a DIFFERENT connection
                -- than the one a probe once verified: the old receipt must
                -- not survive it. Same-target re-registration keeps state.
                state = case when tool_connections.kind <> excluded.kind
                                  or tool_connections.server_ref <> excluded.server_ref
                             then 'registered' else tool_connections.state end,
                last_verified_at = case when tool_connections.kind <> excluded.kind
                                          or tool_connections.server_ref <> excluded.server_ref
                                        then null else tool_connections.last_verified_at end,
                probe_method = case when tool_connections.kind <> excluded.kind
                                      or tool_connections.server_ref <> excluded.server_ref
                                    then null else tool_connections.probe_method end,
                last_tools_count = case when tool_connections.kind <> excluded.kind
                                          or tool_connections.server_ref <> excluded.server_ref
                                        then null else tool_connections.last_tools_count end,
                last_error = case when tool_connections.kind <> excluded.kind
                                    or tool_connections.server_ref <> excluded.server_ref
                                  then null else tool_connections.last_error end,
                updated_by_subject = excluded.updated_by_subject, updated_at = clock_timestamp()
             returning *`,
            [scopeKind, scopeId, serviceId, input.kind, serverRef,
             credentialReference ? JSON.stringify(credentialReference) : null,
             accountLabel, JSON.stringify(grantedScopes), subject],
          );
          return rowOf(r.rows[0]);
        });
      } catch (error) {
        if (isMissingTable(error)) throw Object.assign(new Error('tool connections store unavailable'), { status: 503 });
        throw error;
      }
    },

    async get(tenantId, key) {
      const params = keyParams(key);
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select * from helmion.tool_connections where ${whereKey}`,
            params,
          );
          return rowOf(r.rows[0]);
        });
      } catch (error) {
        if (isMissingTable(error)) return null;
        throw error;
      }
    },

    async list(tenantId, { scopeKind, scopeId } = {}) {
      try {
        return await withTenant(tenantId, async (client) => {
          const clauses = [`tenant_id = current_setting('helmion.tenant_id', true)`];
          const params = [];
          if (scopeKind) { params.push(scopeKind); clauses.push(`scope_kind = $${params.length}`); }
          if (scopeId) { params.push(scopeId); clauses.push(`scope_id = $${params.length}`); }
          const r = await client.query(
            `select * from helmion.tool_connections where ${clauses.join(' and ')} order by service_id, scope_kind, scope_id`,
            params,
          );
          return r.rows.map(rowOf);
        });
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },

    /** A probe is starting. Revoked connections are never probed again. */
    async beginProbe(tenantId, key, subject) {
      const params = keyParams(key);
      return withTenant(tenantId, async (client) => {
        const r = await client.query(
          `update helmion.tool_connections set state = 'probing', updated_by_subject = $4, updated_at = clock_timestamp()
           where ${whereKey} and state <> 'revoked' returning *`,
          [...params, subject],
        );
        if (!r.rows[0]) throw Object.assign(new Error('tool connection not found, or revoked'), { status: 404 });
        return rowOf(r.rows[0]);
      });
    },

    /**
     * THE only writer of 'verified'. Demands the probe's receipt: the
     * method that proved the connection and how many tools answered.
     */
    async recordProbeReceipt(tenantId, key, receipt = {}, subject) {
      const params = keyParams(key);
      const method = String(receipt.method ?? '');
      if (method !== PROBE_METHOD_TOOLS_LIST) {
        throw badRequest(`a verified receipt needs the "${PROBE_METHOD_TOOLS_LIST}" probe method — nothing else proves a callable tool surface`);
      }
      if (!Number.isInteger(receipt.toolsCount) || receipt.toolsCount < 0) {
        throw badRequest('a verified receipt needs the tool count the probe actually got back');
      }
      return withTenant(tenantId, async (client) => {
        const r = await client.query(
          `update helmion.tool_connections
             set state = 'verified', last_verified_at = clock_timestamp(), probe_method = $4,
                 last_tools_count = $5, last_error = null,
                 updated_by_subject = $6, updated_at = clock_timestamp()
           where ${whereKey} returning *`,
          [...params, method, receipt.toolsCount, subject],
        );
        if (!r.rows[0]) throw Object.assign(new Error('tool connection not found'), { status: 404 });
        return rowOf(r.rows[0]);
      });
    },

    /**
     * A probe failed: the connection reads 'failed', the error is kept,
     * and any earlier verified receipt is cleared — freshness never
     * survives a failure.
     */
    async recordProbeFailure(tenantId, key, failure = {}, subject) {
      const params = keyParams(key);
      const method = String(failure.method ?? PROBE_METHOD_TOOLS_LIST);
      const error = String(failure.error ?? 'probe failed').slice(0, MAX_ERROR_CHARS);
      return withTenant(tenantId, async (client) => {
        const r = await client.query(
          `update helmion.tool_connections
             set state = 'failed', probe_method = $4, last_error = $5,
                 last_verified_at = null, last_tools_count = null,
                 updated_by_subject = $6, updated_at = clock_timestamp()
           where ${whereKey} returning *`,
          [...params, method, error, subject],
        );
        if (!r.rows[0]) throw Object.assign(new Error('tool connection not found'), { status: 404 });
        return rowOf(r.rows[0]);
      });
    },

    /** Revocation is a lifecycle act, and it also clears the receipt. */
    async revoke(tenantId, key, subject) {
      const params = keyParams(key);
      return withTenant(tenantId, async (client) => {
        const r = await client.query(
          `update helmion.tool_connections
             set state = 'revoked', last_verified_at = null, last_tools_count = null, last_error = null,
                 updated_by_subject = $4, updated_at = clock_timestamp()
           where ${whereKey} returning *`,
          [...params, subject],
        );
        if (!r.rows[0]) throw Object.assign(new Error('tool connection not found'), { status: 404 });
        return rowOf(r.rows[0]);
      });
    },
  };
}
