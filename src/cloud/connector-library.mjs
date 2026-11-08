// Connector library (connector-library SPEC §2, build bite 1): the store
// over helmion.connector_entries / connector_connections /
// connector_mirrors / connector_snapshots (sql/074) — the per-seat
// library of MCP connectors, plugins, and skills.
//
// A SIBLING of tool-connections.mjs, not an extension of it, by shape:
// that file is one factory over one table whose honesty rules are probe
// receipts for WORKSPACE/AGENT-scoped callable tools. This domain is four
// related records keyed (tenant, person, seat, entry) with different laws
// (broker mode, posture, frozen snapshots). Both stores share the same
// pool, the same tenant-transaction discipline, the same helmion schema,
// and the same credential vault — one database, one custody road, no
// forked credential store. Bite 2's native entries will SURFACE the
// tool-connections rows inside a seat's library; they do not merge the
// two stores' records.
//
// THE LAWS, enforced here in code, not by convention:
//   - brokerMode is set at entry creation and never inferred. There is
//     no default anywhere: createEntry refuses a missing brokerMode, and
//     the column is NOT NULL with no DB default.
//   - If Helmian doesn't hold the token, there is no connection record:
//     brokerMode='vendor' entries take MIRROR records only (§1.5/§2.2),
//     and createConnection refuses them.
//   - Token columns hold VAULT POINTERS ONLY — vault://tenant/<tenant>/…
//     references into the existing credential vault
//     (src/cloud/credential-vault.mjs store/revoke road; the service
//     client's revokeVaultCredential is the same road over HTTP). A raw
//     credential value is refused at the door: any caller field that
//     would carry one (accessToken, refreshToken, token, secret, …) is
//     rejected by name, and a "reference" that isn't a vault pointer for
//     THIS tenant is rejected. Error messages never echo a supplied
//     value — a refused secret must not land in a log through the error.
//   - Per-seat scoping on EVERY read (§3.4): entry reads require the
//     seat, connection/mirror reads require person AND seat. A record
//     written for one seat is invisible to another seat's reads.
//   - Tools run from the frozen snapshot only (§2.3/§5.6). The snapshot
//     stores per-tool input-schema HASHES, never schemas. New or changed
//     tools at a re-freeze enter the enable map OFF (§1.7).
//   - A custom entry is never edited in place (§1.4/§5.10): createEntry
//     refuses a duplicate custom id — remove it and add it again.

import { createHash } from 'node:crypto';

export const CONNECTOR_ENTRY_KINDS = Object.freeze(['catalog', 'helmian-native', 'custom']);
export const CONNECTOR_TRUST_LABELS = Object.freeze(['verified', 'community', 'custom']);
export const CONNECTOR_BROKER_MODES = Object.freeze(['helmian', 'vendor']);
export const CONNECTOR_AUTH_MODES = Object.freeze(['oauth', 'none', 'header']);
export const CONNECTOR_ENTRY_STATES = Object.freeze(['available', 'disabled-by-owner']);
export const CONNECTOR_POSTURES = Object.freeze(['ask', 'read', 'low-risk', 'all']);
export const CONNECTOR_CONNECTION_STATES = Object.freeze(['connected', 'needs-reconnect', 'disconnected']);
export const CONNECTOR_MIRROR_STATES = Object.freeze(['connected', 'not-connected']);
export const CONNECTOR_TOOL_ANNOTATIONS = Object.freeze(['read', 'write', 'undeclared']);

// The credential vault's own reference shape (credential-vault.mjs
// VAULT_REFERENCE + its tenant-prefix rule). Kept in step by hand: the
// vault does not export its pattern, and a stored reference the vault
// would refuse is a pointer at nothing.
const VAULT_REFERENCE = /^vault:\/\/tenant\/[a-z0-9][a-z0-9._:-]{0,127}\/[a-z0-9._:-]{1,96}(?:\/[a-z0-9._:-]{1,96})?$/u;

// Field names that would mean the caller is handing us a credential VALUE
// instead of a reference. Refused by name wherever connection-shaped
// input is accepted — the same discipline as tool-connections.mjs.
const CREDENTIAL_VALUE_KEYS = Object.freeze(['accessToken', 'refreshToken', 'token', 'secret', 'password', 'apiKey', 'api_key', 'credential', 'value']);

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}
function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}
function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}
function isMissingTable(error) {
  return error?.code === '42P01';
}
function storeUnavailable(error) {
  if (isMissingTable(error)) return Object.assign(new Error('connector library store unavailable'), { status: 503 });
  return error;
}

function requireString(value, field, { max = 256 } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${field} is required`);
  const out = value.trim();
  if (out.length > max) throw badRequest(`${field} is too long`);
  return out;
}
function optionalString(value, field, { max = 1024 } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest(`${field} must be a string when given`);
  const out = value.trim();
  if (!out) return null;
  if (out.length > max) throw badRequest(`${field} is too long`);
  return out;
}
function refuseCredentialValues(input) {
  for (const key of CREDENTIAL_VALUE_KEYS) {
    if (key in input) {
      throw badRequest(`"${key}" carries a credential value — connections hold vault references only (accessTokenRef / refreshTokenRef)`);
    }
  }
}
function requireSubject(subject) {
  if (!subject || typeof subject !== 'string') throw badRequest('updated_by_subject is required');
  return subject;
}

// ---------------------------------------------------------------- vault refs

/**
 * Validate a token reference the way the vault itself would: it must be
 * a vault:// pointer, and it must name THIS tenant (credential-vault.mjs
 * validateReference enforces the same prefix before any lookup).
 * The value itself is never echoed into an error.
 */
export function validateVaultTokenRef(reference, tenantId, field = 'token reference') {
  if (typeof reference !== 'string' || !VAULT_REFERENCE.test(reference)) {
    throw badRequest(`${field} must be a vault reference (vault://tenant/<tenant>/…) — raw credential values are never stored`);
  }
  if (!reference.startsWith(`vault://tenant/${String(tenantId).toLowerCase()}/`)) {
    throw badRequest(`${field} names another tenant's vault — a reference is only valid inside its own tenant`);
  }
  return reference;
}

/**
 * The minting convention for connector token references (used by the
 * connect road, Bite 4, when it stores the token pair through the
 * vault's store road): the vault key is (person, seat, connector,
 * account) per §2.4 rule 10; the reference path carries the seat and
 * entry, plus a hash of the person id (person ids are not confined to
 * the vault reference's lowercase charset, and a storage key never needs
 * to be reversible — the connection record holds the real personId).
 * tokenKind is 'access' or 'refresh'.
 */
export function buildConnectorTokenRef({ tenantId, seatId, entryId, personId, tokenKind } = {}) {
  if (!['access', 'refresh'].includes(tokenKind)) throw badRequest('tokenKind must be "access" or "refresh"');
  const tenant = String(tenantId ?? '').trim().toLowerCase();
  const seat = String(seatId ?? '').trim().toLowerCase();
  const entry = String(entryId ?? '').trim().toLowerCase();
  if (!tenant || !seat || !entry || !personId) throw badRequest('tenantId, seatId, entryId, and personId are required to mint a token reference');
  const personKey = createHash('sha256').update(String(personId), 'utf8').digest('hex').slice(0, 32);
  const ref = `vault://tenant/${tenant}/connector.${seat}.${entry}/p-${personKey}.${tokenKind}`;
  return validateVaultTokenRef(ref, tenant);
}

// ------------------------------------------------------------- tool snapshot

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Hash of one tool's input schema — enough to detect change (§2.3). */
export function hashToolInputSchema(inputSchema) {
  return sha256Hex(canonicalJson(inputSchema ?? null));
}

/**
 * The annotation from a tools/list result's annotations object (§2.3):
 * readOnlyHint true → 'read'; explicitly false → 'write' (the server
 * declared the tool is not read-only); absent → 'undeclared'.
 */
export function deriveToolAnnotation(annotations) {
  if (!annotations || typeof annotations !== 'object') return 'undeclared';
  if (annotations.readOnlyHint === true) return 'read';
  if (annotations.readOnlyHint === false) return 'write';
  return 'undeclared';
}

/** What the annotation MEANS wherever it matters: undeclared is write. */
export function effectiveToolAnnotation(annotation) {
  return annotation === 'read' ? 'read' : 'write';
}

/**
 * Plan a frozen snapshot from a raw tools/list result: per-tool
 * {name, description, inputSchemaHash, annotation} (a caller-supplied
 * annotation in the §2.3 enum wins; otherwise it is derived from the
 * tool's annotations), sorted by name, plus the hash over the whole
 * list. The raw schemas are hashed and dropped — never stored.
 */
export function planToolSnapshot(tools) {
  if (!Array.isArray(tools)) throw badRequest('a tool snapshot needs the tools/list result array');
  const seen = new Set();
  const planned = tools.map((tool, index) => {
    if (!tool || typeof tool !== 'object') throw badRequest(`tool at index ${index} is not an object`);
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name) throw badRequest(`tool at index ${index} has no name`);
    if (seen.has(name)) throw badRequest(`tool "${name}" appears twice in one tools/list result — the enable map is keyed by name, so a duplicate is ambiguous`);
    seen.add(name);
    const annotation = CONNECTOR_TOOL_ANNOTATIONS.includes(tool.annotation)
      ? tool.annotation
      : deriveToolAnnotation(tool.annotations);
    return {
      name,
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchemaHash: hashToolInputSchema(tool.inputSchema),
      annotation,
    };
  });
  planned.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const snapshotHash = sha256Hex(canonicalJson(planned.map((t) => [t.name, t.description, t.inputSchemaHash, t.annotation])));
  return { tools: planned, snapshotHash };
}

/**
 * The §1.7 change review as a pure diff: which tools were added, which
 * removed, which changed (description, schema hash, or annotation)
 * between a stored snapshot's tools and a fresh tools/list plan.
 */
export function diffToolSnapshots(storedTools, freshTools) {
  const stored = new Map((storedTools ?? []).map((t) => [t.name, t]));
  const fresh = new Map((freshTools ?? []).map((t) => [t.name, t]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [name, tool] of fresh) {
    const before = stored.get(name);
    if (!before) { added.push(name); continue; }
    if (before.description !== tool.description
      || before.inputSchemaHash !== tool.inputSchemaHash
      || before.annotation !== tool.annotation) changed.push(name);
  }
  for (const name of stored.keys()) if (!fresh.has(name)) removed.push(name);
  return { added, removed, changed };
}

// ------------------------------------------------------------------ row maps

function entryOf(row) {
  if (!row) return null;
  return {
    seatId: row.seat_id,
    id: row.id,
    kind: row.kind,
    name: row.name,
    oneLiner: row.one_liner,
    iconRef: row.icon_ref ?? null,
    vendorName: row.vendor_name,
    trustLabel: row.trust_label,
    category: row.category ?? null,
    brokerMode: row.broker_mode,
    mcpEndpointUrl: row.mcp_endpoint_url ?? null,
    vendorConnectorRef: row.vendor_connector_ref ?? null,
    authMode: row.auth_mode,
    clientIdentity: row.client_identity ?? null,
    scopesSummary: row.scopes_summary ?? null,
    addedBy: row.added_by,
    addedAt: row.added_at ?? null,
    workspaceProvisioned: row.workspace_provisioned === true,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function connectionOf(row) {
  if (!row) return null;
  return {
    id: row.id,
    personId: row.person_id,
    seatId: row.seat_id,
    entryId: row.entry_id,
    accountIdentity: row.account_identity,
    accessTokenRef: row.access_token_ref ?? null,
    refreshTokenRef: row.refresh_token_ref ?? null,
    grantedScopes: Array.isArray(row.granted_scopes) ? row.granted_scopes : [],
    posture: row.posture,
    toolEnableMap: row.tool_enable_map && typeof row.tool_enable_map === 'object' ? row.tool_enable_map : {},
    toolSnapshotRef: row.tool_snapshot_ref ?? null,
    state: row.state,
    lastDiscoveryAt: row.last_discovery_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mirrorOf(row) {
  if (!row) return null;
  return {
    personId: row.person_id,
    seatId: row.seat_id,
    entryId: row.entry_id,
    reportedState: row.reported_state,
    reportedAccountIdentity: row.reported_account_identity ?? null,
    reportedAt: row.reported_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function snapshotOf(row) {
  if (!row) return null;
  return {
    id: row.id,
    connectionId: row.connection_id,
    takenAt: row.taken_at ?? null,
    tools: Array.isArray(row.tools) ? row.tools : [],
    snapshotHash: row.snapshot_hash,
  };
}

// ---------------------------------------------------------------- validators

function validateEndpointUrl(value) {
  const url = optionalString(value, 'mcpEndpointUrl');
  if (url === null) return null;
  let parsed;
  try { parsed = new URL(url); } catch { throw badRequest('mcpEndpointUrl must be a public HTTPS MCP endpoint URL'); }
  if (parsed.protocol !== 'https:') throw badRequest('mcpEndpointUrl must be HTTPS — connections are made from Helmian\'s servers (§2.4 rule 1)');
  if (parsed.username || parsed.password) throw badRequest('mcpEndpointUrl must not carry credentials in the URL');
  return url;
}

function validateVendorConnectorRef(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('vendorConnectorRef must be an object {ref, manageUrl}');
  const ref = requireString(value.ref, 'vendorConnectorRef.ref', { max: 256 });
  const manageUrl = requireString(value.manageUrl, 'vendorConnectorRef.manageUrl', { max: 1024 });
  let parsed;
  try { parsed = new URL(manageUrl); } catch { throw badRequest('vendorConnectorRef.manageUrl must be a URL'); }
  if (parsed.protocol !== 'https:') throw badRequest('vendorConnectorRef.manageUrl must be HTTPS');
  if (parsed.username || parsed.password) throw badRequest('vendorConnectorRef.manageUrl must not carry credentials in the URL');
  return { ref, manageUrl };
}

function validateEntryInput(input = {}) {
  refuseCredentialValues(input);
  if ('state' in input) {
    throw badRequest('entry state cannot be set at creation — entries are created "available"; disabled-by-owner is a later owner act');
  }
  const seatId = requireString(input.seatId, 'seatId', { max: 128 });
  const id = requireString(input.id, 'entry id', { max: 128 });
  if (!CONNECTOR_ENTRY_KINDS.includes(input.kind)) {
    throw badRequest(`kind must be one of ${CONNECTOR_ENTRY_KINDS.join(', ')}`);
  }
  // brokerMode: REQUIRED, never defaulted, never inferred (§2.1).
  if (!CONNECTOR_BROKER_MODES.includes(input.brokerMode)) {
    throw badRequest('brokerMode is required at creation and must be "helmian" or "vendor" — it is never inferred later');
  }
  if (!CONNECTOR_AUTH_MODES.includes(input.authMode)) {
    throw badRequest(`authMode must be one of ${CONNECTOR_AUTH_MODES.join(', ')}`);
  }
  let trustLabel = input.trustLabel;
  if (input.kind === 'custom') {
    if (trustLabel !== undefined && trustLabel !== 'custom') {
      throw badRequest('custom entries are always trust-labelled "custom" (§2.1)');
    }
    trustLabel = 'custom';
  } else if (!CONNECTOR_TRUST_LABELS.includes(trustLabel) || trustLabel === 'custom') {
    throw badRequest('trustLabel must be "verified" or "community" for catalog and helmian-native entries');
  }
  const mcpEndpointUrl = validateEndpointUrl(input.mcpEndpointUrl);
  const vendorConnectorRef = validateVendorConnectorRef(input.vendorConnectorRef);
  if (input.brokerMode === 'helmian') {
    if (!mcpEndpointUrl) throw badRequest('a helmian-brokered entry needs its mcpEndpointUrl — Helmian runs the pipe');
    if (vendorConnectorRef) throw badRequest('a helmian-brokered entry carries no vendorConnectorRef');
  } else {
    if (mcpEndpointUrl) throw badRequest('a vendor-brokered entry has no mcpEndpointUrl — Helmian has no pipe for it (§1.5)');
    if (!vendorConnectorRef) throw badRequest('a vendor-brokered entry needs vendorConnectorRef {ref, manageUrl} — the vendor-side identifier and its management link');
  }
  return {
    seatId,
    id,
    kind: input.kind,
    name: requireString(input.name, 'name'),
    oneLiner: requireString(input.oneLiner, 'oneLiner', { max: 512 }),
    iconRef: optionalString(input.iconRef, 'iconRef'),
    vendorName: requireString(input.vendorName, 'vendorName'),
    trustLabel,
    category: optionalString(input.category, 'category', { max: 128 }),
    brokerMode: input.brokerMode,
    mcpEndpointUrl,
    vendorConnectorRef,
    authMode: input.authMode,
    clientIdentity: optionalString(input.clientIdentity, 'clientIdentity'),
    scopesSummary: optionalString(input.scopesSummary, 'scopesSummary'),
    addedBy: requireString(input.addedBy, 'addedBy'),
    workspaceProvisioned: input.workspaceProvisioned === true,
  };
}

function connectionKeyParams(key = {}) {
  const personId = requireString(key.personId ?? '', 'personId');
  const seatId = requireString(key.seatId ?? '', 'seatId', { max: 128 });
  const entryId = requireString(key.entryId ?? '', 'entryId', { max: 128 });
  return { personId, seatId, entryId };
}

function validateScopes(scopes) {
  const out = scopes ?? [];
  if (!Array.isArray(out) || out.some((s) => typeof s !== 'string')) {
    throw badRequest('grantedScopes must be an array of scope names');
  }
  return out;
}

function validateTokenRefs(input, entry, tenantId) {
  const accessTokenRef = input.accessTokenRef ?? null;
  const refreshTokenRef = input.refreshTokenRef ?? null;
  if (entry.auth_mode === 'none') {
    if (accessTokenRef !== null || refreshTokenRef !== null) {
      throw badRequest('this entry uses no sign-in (authMode "none") — there are no tokens to reference');
    }
    return { accessTokenRef: null, refreshTokenRef: null };
  }
  if (accessTokenRef === null) {
    throw badRequest('accessTokenRef is required — the vault pointer for the access token the connect flow stored');
  }
  return {
    accessTokenRef: validateVaultTokenRef(accessTokenRef, tenantId, 'accessTokenRef'),
    refreshTokenRef: refreshTokenRef === null ? null : validateVaultTokenRef(refreshTokenRef, tenantId, 'refreshTokenRef'),
  };
}

// --------------------------------------------------------------------- store

export function createConnectorLibraryStore(pool) {
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

  const whereEntry = `tenant_id = current_setting('helmion.tenant_id', true) and seat_id = $1 and id = $2`;
  const whereConnection = `tenant_id = current_setting('helmion.tenant_id', true) and person_id = $1 and seat_id = $2 and entry_id = $3`;
  const whereMirror = whereConnection;

  async function readEntry(client, seatId, entryId) {
    const r = await client.query(
      `select * from helmion.connector_entries where ${whereEntry}`,
      [seatId, entryId],
    );
    return r.rows[0] ?? null;
  }
  async function readConnection(client, key) {
    const r = await client.query(
      `select * from helmion.connector_connections where ${whereConnection}`,
      [key.personId, key.seatId, key.entryId],
    );
    return r.rows[0] ?? null;
  }

  return {
    // ------------------------------------------------------------ entries

    /**
     * Create a library entry. Catalog and helmian-native entries may be
     * refreshed by re-creating them with the same id (descriptive fields
     * update; brokerMode may NOT change — a different brokerMode is a
     * different entry). Custom entries are insert-only (§5.10): a
     * duplicate custom id is refused — remove it and add it again.
     */
    async createEntry(tenantId, subject, input = {}) {
      requireSubject(subject);
      const entry = validateEntryInput(input);
      try {
        return await withTenant(tenantId, async (client) => {
          const existing = await readEntry(client, entry.seatId, entry.id);
          if (existing) {
            if (existing.kind === 'custom' || entry.kind === 'custom') {
              throw conflict('a custom connector is never edited in place — remove it and add it again (§1.4)');
            }
            if (existing.broker_mode !== entry.brokerMode) {
              throw conflict('brokerMode is set at creation and never changes — this id already exists with a different brokerMode');
            }
            const r = await client.query(
              `update helmion.connector_entries
                 set name = $3, one_liner = $4, icon_ref = $5, vendor_name = $6,
                     trust_label = $7, category = $8, mcp_endpoint_url = $9,
                     vendor_connector_ref = $10::jsonb, auth_mode = $11,
                     client_identity = $12, scopes_summary = $13,
                     workspace_provisioned = $14, updated_at = clock_timestamp()
               where ${whereEntry} returning *`,
              [entry.seatId, entry.id, entry.name, entry.oneLiner, entry.iconRef,
               entry.vendorName, entry.trustLabel, entry.category, entry.mcpEndpointUrl,
               entry.vendorConnectorRef ? JSON.stringify(entry.vendorConnectorRef) : null,
               entry.authMode, entry.clientIdentity, entry.scopesSummary, entry.workspaceProvisioned],
            );
            return entryOf(r.rows[0]);
          }
          const r = await client.query(
            `insert into helmion.connector_entries
               (tenant_id, seat_id, id, kind, name, one_liner, icon_ref, vendor_name,
                trust_label, category, broker_mode, mcp_endpoint_url, vendor_connector_ref,
                auth_mode, client_identity, scopes_summary, added_by, workspace_provisioned, state)
             values (current_setting('helmion.tenant_id', true), $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, 'available')
             returning *`,
            [entry.seatId, entry.id, entry.kind, entry.name, entry.oneLiner, entry.iconRef,
             entry.vendorName, entry.trustLabel, entry.category, entry.brokerMode,
             entry.mcpEndpointUrl, entry.vendorConnectorRef ? JSON.stringify(entry.vendorConnectorRef) : null,
             entry.authMode, entry.clientIdentity, entry.scopesSummary, entry.addedBy,
             entry.workspaceProvisioned],
          );
          return entryOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    /** One seat's entry. A record written for another seat reads as absent. */
    async getEntry(tenantId, seatId, entryId) {
      const seat = requireString(seatId ?? '', 'seatId', { max: 128 });
      const id = requireString(entryId ?? '', 'entryId', { max: 128 });
      try {
        return await withTenant(tenantId, async (client) => entryOf(await readEntry(client, seat, id)));
      } catch (error) {
        if (isMissingTable(error)) return null;
        throw error;
      }
    },

    /** One seat's library. The seat filter is mandatory — there is no cross-seat read. */
    async listEntries(tenantId, seatId) {
      const seat = requireString(seatId ?? '', 'seatId', { max: 128 });
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select * from helmion.connector_entries
              where tenant_id = current_setting('helmion.tenant_id', true) and seat_id = $1
              order by id`,
            [seat],
          );
          return r.rows.map(entryOf);
        });
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },

    /** The entry-level owner act (§2.1 state): available / disabled-by-owner. */
    async setEntryState(tenantId, seatId, entryId, state, subject) {
      requireSubject(subject);
      const seat = requireString(seatId ?? '', 'seatId', { max: 128 });
      const id = requireString(entryId ?? '', 'entryId', { max: 128 });
      if (!CONNECTOR_ENTRY_STATES.includes(state)) {
        throw badRequest(`entry state must be one of ${CONNECTOR_ENTRY_STATES.join(', ')}`);
      }
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `update helmion.connector_entries set state = $3, updated_at = clock_timestamp()
              where ${whereEntry} returning *`,
            [seat, id, state],
          );
          if (!r.rows[0]) throw notFound('connector entry not found in this seat\'s library');
          return entryOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    /**
     * Remove an entry and everything under it (connections, mirrors, and
     * their snapshots cascade in sql/074). This is the remove half of
     * remove-and-re-add for custom entries; who may call it is the
     * caller's gate (Surface B / Bite 6), not the store's.
     */
    async removeEntry(tenantId, seatId, entryId, subject) {
      requireSubject(subject);
      const seat = requireString(seatId ?? '', 'seatId', { max: 128 });
      const id = requireString(entryId ?? '', 'entryId', { max: 128 });
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `delete from helmion.connector_entries where ${whereEntry} returning *`,
            [seat, id],
          );
          if (!r.rows[0]) throw notFound('connector entry not found in this seat\'s library');
          return entryOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    // -------------------------------------------------------- connections

    /**
     * Record a completed connection (§1.3 step 3's landing): the entry
     * must exist in this seat's library, be available, and be
     * helmian-brokered — vendor-brokered entries take mirror records,
     * never token connections. The triple (person, seat, entry) is
     * unique; a second create is refused (reconnect is
     * updateConnectionTokens, not a silent overwrite).
     */
    async createConnection(tenantId, subject, input = {}) {
      requireSubject(subject);
      refuseCredentialValues(input);
      if ('state' in input) throw badRequest('connection state cannot be set at creation — a connection is recorded connected');
      const key = connectionKeyParams(input);
      const posture = input.posture ?? 'ask';
      if (!CONNECTOR_POSTURES.includes(posture)) {
        throw badRequest(`posture must be one of ${CONNECTOR_POSTURES.join(', ')}`);
      }
      const accountIdentity = requireString(input.accountIdentity ?? '', 'accountIdentity', { max: 512 });
      const grantedScopes = validateScopes(input.grantedScopes);
      try {
        return await withTenant(tenantId, async (client) => {
          const entry = await readEntry(client, key.seatId, key.entryId);
          if (!entry) throw notFound('connector entry not found in this seat\'s library');
          if (entry.state !== 'available') throw conflict('this connector is turned off by the workspace owner');
          if (entry.broker_mode !== 'helmian') {
            throw badRequest('this entry is vendor-brokered — Helmian holds no tokens for it; record a mirror report instead (§1.5)');
          }
          const refs = validateTokenRefs(input, entry, tenantId);
          const existing = await readConnection(client, key);
          if (existing) throw conflict('this person already has a connection for this connector in this seat — v1 is one account per person per connector per seat');
          const r = await client.query(
            `insert into helmion.connector_connections
               (tenant_id, person_id, seat_id, entry_id, account_identity,
                access_token_ref, refresh_token_ref, granted_scopes, posture, state)
             values (current_setting('helmion.tenant_id', true), $1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'connected')
             returning *`,
            [key.personId, key.seatId, key.entryId, accountIdentity,
             refs.accessTokenRef, refs.refreshTokenRef, JSON.stringify(grantedScopes), posture],
          );
          return connectionOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    async getConnection(tenantId, key) {
      const params = connectionKeyParams(key);
      try {
        return await withTenant(tenantId, async (client) => connectionOf(await readConnection(client, params)));
      } catch (error) {
        if (isMissingTable(error)) return null;
        throw error;
      }
    },

    /** One person's connections in ONE seat. Person and seat are both mandatory. */
    async listConnections(tenantId, filter = {}) {
      const personId = requireString(filter.personId ?? '', 'personId');
      const seatId = requireString(filter.seatId ?? '', 'seatId', { max: 128 });
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select * from helmion.connector_connections
              where tenant_id = current_setting('helmion.tenant_id', true) and person_id = $1 and seat_id = $2
              order by entry_id`,
            [personId, seatId],
          );
          return r.rows.map(connectionOf);
        });
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },

    /**
     * The reconnect / refresh landing (§1.7): new vault pointers (and,
     * when the provider returned them, the account identity and granted
     * scopes) replace the old ones, and the connection reads connected
     * again. The OLD tokens' vault records are the caller's to revoke
     * through the vault's revoke road — the returned record's previous
     * refs are not kept anywhere in this store.
     */
    async updateConnectionTokens(tenantId, key, input = {}, subject) {
      requireSubject(subject);
      refuseCredentialValues(input);
      const params = connectionKeyParams(key);
      try {
        return await withTenant(tenantId, async (client) => {
          const existing = await readConnection(client, params);
          if (!existing) throw notFound('connection not found');
          const entry = await readEntry(client, params.seatId, params.entryId);
          if (!entry) throw notFound('connector entry not found in this seat\'s library');
          const refs = validateTokenRefs(input, entry, tenantId);
          const accountIdentity = input.accountIdentity === undefined
            ? existing.account_identity
            : requireString(input.accountIdentity ?? '', 'accountIdentity', { max: 512 });
          const grantedScopes = input.grantedScopes === undefined
            ? (Array.isArray(existing.granted_scopes) ? existing.granted_scopes : [])
            : validateScopes(input.grantedScopes);
          const r = await client.query(
            `update helmion.connector_connections
               set access_token_ref = $4, refresh_token_ref = $5, account_identity = $6,
                   granted_scopes = $7::jsonb, state = 'connected', updated_at = clock_timestamp()
             where ${whereConnection} returning *`,
            [params.personId, params.seatId, params.entryId, refs.accessTokenRef, refs.refreshTokenRef, accountIdentity, JSON.stringify(grantedScopes)],
          );
          return connectionOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    /** Posture governs when the Guard asks — never access (§2.2). */
    async setPosture(tenantId, key, posture, subject) {
      requireSubject(subject);
      const params = connectionKeyParams(key);
      if (!CONNECTOR_POSTURES.includes(posture)) {
        throw badRequest(`posture must be one of ${CONNECTOR_POSTURES.join(', ')}`);
      }
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `update helmion.connector_connections set posture = $4, updated_at = clock_timestamp()
              where ${whereConnection} returning *`,
            [params.personId, params.seatId, params.entryId, posture],
          );
          if (!r.rows[0]) throw notFound('connection not found');
          return connectionOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    /** §1.3/§1.7: a failed refresh or an authorization refusal lands here — honestly, never silently. */
    async markNeedsReconnect(tenantId, key, subject) {
      requireSubject(subject);
      const params = connectionKeyParams(key);
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `update helmion.connector_connections set state = 'needs-reconnect', updated_at = clock_timestamp()
              where ${whereConnection} returning *`,
            [params.personId, params.seatId, params.entryId],
          );
          if (!r.rows[0]) throw notFound('connection not found');
          return connectionOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    async touchLastUsed(tenantId, key) {
      const params = connectionKeyParams(key);
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `update helmion.connector_connections set last_used_at = clock_timestamp(), updated_at = clock_timestamp()
              where ${whereConnection} returning *`,
            [params.personId, params.seatId, params.entryId],
          );
          if (!r.rows[0]) throw notFound('connection not found');
          return connectionOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    /**
     * Per-tool on/off against the CURRENT frozen snapshot (§2.2). Keys
     * must name tools in the snapshot — a map naming tools the snapshot
     * doesn't hold is refused, so a stale UI can never invent a tool.
     * Partial maps merge over the stored one.
     */
    async setToolEnableMap(tenantId, key, map, subject) {
      requireSubject(subject);
      const params = connectionKeyParams(key);
      if (!map || typeof map !== 'object' || Array.isArray(map)) throw badRequest('toolEnableMap must be an object keyed by tool name');
      for (const [name, value] of Object.entries(map)) {
        if (typeof value !== 'boolean') throw badRequest(`toolEnableMap["${name}"] must be true or false`);
      }
      try {
        return await withTenant(tenantId, async (client) => {
          const existing = await readConnection(client, params);
          if (!existing) throw notFound('connection not found');
          if (!existing.tool_snapshot_ref) throw badRequest('this connection has no frozen tool snapshot yet — tools are enabled against the snapshot, never freehand');
          const snap = await client.query(
            `select * from helmion.connector_snapshots where id = $1`,
            [existing.tool_snapshot_ref],
          );
          const known = new Set((snap.rows[0]?.tools ?? []).map((t) => t.name));
          for (const name of Object.keys(map)) {
            if (!known.has(name)) throw badRequest(`tool "${name}" is not in this connection's frozen snapshot`);
          }
          const merged = { ...(existing.tool_enable_map ?? {}), ...map };
          const r = await client.query(
            `update helmion.connector_connections set tool_enable_map = $4::jsonb, updated_at = clock_timestamp()
              where ${whereConnection} returning *`,
            [params.personId, params.seatId, params.entryId, JSON.stringify(merged)],
          );
          return connectionOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    /**
     * Disconnect (§1.7): the record flips to disconnected and its token
     * references are CLEARED — a pointer at a revoked token must not
     * linger. Revoking the vault records themselves rides the existing
     * vault revoke road: pass `revoke` (an async (ref) => void wired to
     * credential-vault revokeCredential / the service client's
     * revokeVaultCredential with the caller's actor context) and it runs
     * for each stored reference BEFORE the record is cleared; the
     * references revoked are returned either way so the caller can audit
     * or revoke itself. The snapshot rows stay as history; the
     * connection no longer points at one.
     */
    async disconnectConnection(tenantId, key, subject, { revoke } = {}) {
      requireSubject(subject);
      const params = connectionKeyParams(key);
      let prior;
      try {
        prior = await withTenant(tenantId, async (client) => readConnection(client, params));
      } catch (error) { throw storeUnavailable(error); }
      if (!prior) throw notFound('connection not found');
      if (prior.state === 'disconnected') return { connection: connectionOf(prior), revokedRefs: [] };
      const refs = [prior.access_token_ref, prior.refresh_token_ref].filter(Boolean);
      if (revoke !== undefined) {
        if (typeof revoke !== 'function') throw badRequest('revoke must be an async function when given');
        for (const ref of refs) await revoke(ref);
      }
      try {
        const updated = await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `update helmion.connector_connections
               set state = 'disconnected', access_token_ref = null, refresh_token_ref = null,
                   tool_snapshot_ref = null, updated_at = clock_timestamp()
             where ${whereConnection} returning *`,
            [params.personId, params.seatId, params.entryId],
          );
          return connectionOf(r.rows[0]);
        });
        return { connection: updated, revokedRefs: refs };
      } catch (error) { throw storeUnavailable(error); }
    },

    // ---------------------------------------------------------- snapshots

    /**
     * Freeze a tools/list result onto a connection (§2.3): the snapshot
     * row is inserted, the connection points at it, lastDiscoveryAt is
     * stamped, and the enable map is merged by the §1.7 rule — on a
     * re-freeze, tools that are new or changed enter OFF, unchanged
     * tools keep the person's setting, removed tools drop out. On the
     * FIRST freeze the reviewed set enters ON: the connect flow just
     * showed the person these tools (§1.4 step 4 / §1.3 step 3), and
     * consent covers exactly the frozen set.
     */
    async freezeSnapshot(tenantId, key, toolsListResult, subject) {
      requireSubject(subject);
      const params = connectionKeyParams(key);
      const plan = planToolSnapshot(toolsListResult);
      try {
        return await withTenant(tenantId, async (client) => {
          const existing = await readConnection(client, params);
          if (!existing) throw notFound('connection not found');
          const firstFreeze = !existing.tool_snapshot_ref;
          let priorTools = [];
          if (!firstFreeze) {
            const snap = await client.query(
              `select * from helmion.connector_snapshots where id = $1`,
              [existing.tool_snapshot_ref],
            );
            priorTools = snap.rows[0]?.tools ?? [];
          }
          const diff = diffToolSnapshots(priorTools, plan.tools);
          const settled = new Set([...diff.added, ...diff.changed]);
          const priorMap = existing.tool_enable_map ?? {};
          const enableMap = {};
          for (const tool of plan.tools) {
            enableMap[tool.name] = firstFreeze ? true : (settled.has(tool.name) ? false : priorMap[tool.name] !== false);
          }
          const ins = await client.query(
            `insert into helmion.connector_snapshots (tenant_id, connection_id, tools, snapshot_hash)
             values (current_setting('helmion.tenant_id', true), $1, $2::jsonb, $3)
             returning *`,
            [existing.id, JSON.stringify(plan.tools), plan.snapshotHash],
          );
          const snapshot = snapshotOf(ins.rows[0]);
          await client.query(
            `update helmion.connector_connections
               set tool_snapshot_ref = $4, last_discovery_at = clock_timestamp(),
                   tool_enable_map = $5::jsonb, updated_at = clock_timestamp()
             where ${whereConnection}`,
            [params.personId, params.seatId, params.entryId, snapshot.id, JSON.stringify(enableMap)],
          );
          return snapshot;
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    /** The snapshot a connection is currently running, or null. Scoped by the connection key. */
    async getCurrentSnapshot(tenantId, key) {
      const params = connectionKeyParams(key);
      try {
        return await withTenant(tenantId, async (client) => {
          const existing = await readConnection(client, params);
          if (!existing || !existing.tool_snapshot_ref) return null;
          const snap = await client.query(
            `select * from helmion.connector_snapshots where id = $1`,
            [existing.tool_snapshot_ref],
          );
          return snapshotOf(snap.rows[0]);
        });
      } catch (error) {
        if (isMissingTable(error)) return null;
        throw error;
      }
    },

    // ------------------------------------------------------------ mirrors

    /**
     * A vendor-side state report (§1.5): the ONLY writer of mirror
     * records. The entry must be vendor-brokered — a mirror for a
     * helmian entry would be a state Helmian never received from anyone.
     */
    async recordMirrorReport(tenantId, subject, input = {}) {
      requireSubject(subject);
      refuseCredentialValues(input);
      const key = connectionKeyParams(input);
      if (!CONNECTOR_MIRROR_STATES.includes(input.reportedState)) {
        throw badRequest(`reportedState must be one of ${CONNECTOR_MIRROR_STATES.join(', ')}`);
      }
      const reportedAccountIdentity = optionalString(input.reportedAccountIdentity, 'reportedAccountIdentity', { max: 512 });
      let reportedAt = null;
      if (input.reportedAt !== undefined && input.reportedAt !== null) {
        const when = new Date(input.reportedAt);
        if (!Number.isFinite(when.getTime())) throw badRequest('reportedAt must be a valid timestamp when given');
        reportedAt = when.toISOString();
      }
      try {
        return await withTenant(tenantId, async (client) => {
          const entry = await readEntry(client, key.seatId, key.entryId);
          if (!entry) throw notFound('connector entry not found in this seat\'s library');
          if (entry.broker_mode !== 'vendor') {
            throw badRequest('mirror records belong to vendor-brokered entries only — a helmian-brokered entry\'s state is its connection record');
          }
          const r = await client.query(
            `insert into helmion.connector_mirrors
               (tenant_id, person_id, seat_id, entry_id, reported_state, reported_account_identity, reported_at)
             values (current_setting('helmion.tenant_id', true), $1, $2, $3, $4, $5, coalesce($6::timestamptz, clock_timestamp()))
             on conflict (tenant_id, person_id, seat_id, entry_id)
             do update set reported_state = excluded.reported_state,
                reported_account_identity = excluded.reported_account_identity,
                reported_at = excluded.reported_at, updated_at = clock_timestamp()
             returning *`,
            [key.personId, key.seatId, key.entryId, input.reportedState, reportedAccountIdentity, reportedAt],
          );
          return mirrorOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    async getMirror(tenantId, key) {
      const params = connectionKeyParams(key);
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select * from helmion.connector_mirrors where ${whereMirror}`,
            [params.personId, params.seatId, params.entryId],
          );
          return mirrorOf(r.rows[0]);
        });
      } catch (error) {
        if (isMissingTable(error)) return null;
        throw error;
      }
    },

    /** One person's mirror records in ONE seat. Person and seat are both mandatory. */
    async listMirrors(tenantId, filter = {}) {
      const personId = requireString(filter.personId ?? '', 'personId');
      const seatId = requireString(filter.seatId ?? '', 'seatId', { max: 128 });
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select * from helmion.connector_mirrors
              where tenant_id = current_setting('helmion.tenant_id', true) and person_id = $1 and seat_id = $2
              order by entry_id`,
            [personId, seatId],
          );
          return r.rows.map(mirrorOf);
        });
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },
  };
}
