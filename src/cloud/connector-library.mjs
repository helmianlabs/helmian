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
//   - Scoping (§3.4, as amended by the workspace connector SET,
//     SYNC S1): entry reads require the seat, mirror reads require
//     person AND seat — both are unchanged. CONNECTION reads are
//     scoped to the person's WORKSPACE SET: one set per (tenant,
//     person, entry), resolved by the SET COLLAPSE RULE below. The
//     seat a connection was set up on is provenance on the record
//     (its seat_id), not the owner of the row: any seat whose own
//     library carries the entry reads and arms the set's row, and
//     every connection write lands on that row.
//   - Scoping, the entry-level half (SYNC S2a): a CUSTOM entry is
//     the person's own — one physical row, on the seat it was
//     created on (its provenance seat, recorded on the record),
//     owned by the person its added_by names. Person-scoped entry
//     reads PROJECT that one row into every seat's library for its
//     owner: the same entry id, the same record, no copies stocked.
//     Catalog / helmian-native / mcp-local entries are NOT
//     projected — their per-seat stocking is unchanged (GATE 1
//     stands for them). Another person's custom entries, and
//     another tenant's, are never projected. Legacy duplicate
//     physical rows for one (person, custom id) — creatable before
//     the projection existed — collapse by the ENTRY COLLAPSE RULE
//     below, the entry-level mirror of S1's set rule.
//   - Tools run from the frozen snapshot only (§2.3/§5.6). The snapshot
//     stores per-tool input-schema HASHES, never schemas. New or changed
//     tools at a re-freeze enter the enable map OFF (§1.7).
//   - A custom entry is never edited in place (§1.4/§5.10): createEntry
//     refuses a duplicate custom id — remove it and add it again.

import { createHash } from 'node:crypto';

export const CONNECTOR_ENTRY_KINDS = Object.freeze(['catalog', 'helmian-native', 'custom', 'mcp-local']);
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

/**
 * Plan a prompt snapshot from a raw prompts/list result (mirror-design
 * §4, bite M2): the MCP prompt primitive is the protocol's own carrier
 * for server-published starter templates, so a brokered server's
 * prompts get the same treatment as its tools — per-prompt
 * {name, title, description, arguments:[{name, description, required}]}
 * sorted by name, plus the hash over the whole list. The plan is the
 * shape the prompts route answers with and the shape a future freeze
 * would store; argument schemas beyond name/required are dropped, the
 * same discipline as tool input schemas (hashed for tools, unused for
 * prompts — a prompt's draft is rendered by prompts/get, not built
 * from its schema).
 */
export function planPromptSnapshot(prompts) {
  if (!Array.isArray(prompts)) throw badRequest('a prompt snapshot needs the prompts/list result array');
  const seen = new Set();
  const planned = prompts.map((prompt, index) => {
    if (!prompt || typeof prompt !== 'object') throw badRequest(`prompt at index ${index} is not an object`);
    const name = typeof prompt.name === 'string' ? prompt.name.trim() : '';
    if (!name) throw badRequest(`prompt at index ${index} has no name`);
    if (seen.has(name)) throw badRequest(`prompt "${name}" appears twice in one prompts/list result — the menu is keyed by name, so a duplicate is ambiguous`);
    seen.add(name);
    const args = (Array.isArray(prompt.arguments) ? prompt.arguments : []).map((arg, argIndex) => {
      const argName = typeof arg?.name === 'string' ? arg.name.trim() : '';
      if (!argName) throw badRequest(`prompt "${name}" argument at index ${argIndex} has no name`);
      return {
        name: argName,
        description: typeof arg.description === 'string' ? arg.description : '',
        required: arg.required === true,
      };
    });
    return {
      name,
      title: typeof prompt.title === 'string' ? prompt.title : null,
      description: typeof prompt.description === 'string' ? prompt.description : '',
      arguments: args,
    };
  });
  planned.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const snapshotHash = sha256Hex(canonicalJson(planned.map((p) => [p.name, p.title, p.description, p.arguments.map((a) => [a.name, a.description, a.required])])));
  return { prompts: planned, snapshotHash };
}

/**
 * The composer draft a prompt row seeds when the prompt cannot be
 * rendered without input (mirror-design §4: choosing a starter seeds
 * a DRAFT — it never silently sends). Built only from the prompt's
 * own descriptor: its description (or name) as the ask, then one
 * fill-in line per required argument. Prompts with no required
 * arguments are rendered by the server instead (prompts/get) and
 * never pass through here.
 */
export function promptDraftText(prompt) {
  const head = (typeof prompt?.description === 'string' && prompt.description.trim())
    ? prompt.description.trim()
    : String(prompt?.title ?? prompt?.name ?? '').trim();
  const lines = [head || 'Use this starter:'];
  for (const arg of Array.isArray(prompt?.arguments) ? prompt.arguments : []) {
    if (arg?.required) lines.push(`${arg.name}: `);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ row maps

function entryOf(row, seatOverride = null) {
  if (!row) return null;
  return {
    seatId: seatOverride ?? row.seat_id,
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
    // The local facts (sql/080): an mcp-local entry's shape in place
    // of an endpoint — where the install lives on a person's
    // machine, how it is started there, and the install pipeline's
    // baseline fingerprint. Null on every other kind (the schema
    // requires it), and on rows read from a pre-080 database.
    installedPath: row.installed_path ?? null,
    configSnippet: row.config_snippet ?? null,
    baselineFingerprint: row.baseline_fingerprint ?? null,
    authMode: row.auth_mode,
    clientIdentity: row.client_identity ?? null,
    scopesSummary: row.scopes_summary ?? null,
    addedBy: row.added_by,
    addedAt: row.added_at ?? null,
    // A custom entry's provenance (SYNC S2a): the seat its one
    // physical row lives on — the seat it was created through.
    // `seatId` above is the seat this record is being READ as
    // (the projection answers in the requesting seat's name);
    // provenanceSeatId never moves. Custom entries only: every
    // other kind is stocked per seat and its seatId is its address.
    ...(row.kind === 'custom' ? { provenanceSeatId: row.seat_id, workspaceCustom: true } : {}),
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

const HEX64 = /^[a-f0-9]{64}$/;

/**
 * An mcp-local entry's config snippet (sql/080): the document the
 * install pipeline printed — { mcpServers: { <name>: { command,
 * args } } } — and it must carry THIS entry's server: a snippet
 * naming another server is a connection fact for a different
 * install, not decoration. Returns the object unchanged (it lands
 * in a jsonb column as given).
 */
function validateConfigSnippet(value, serverName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !value.mcpServers || typeof value.mcpServers !== 'object' || Array.isArray(value.mcpServers)) {
    throw badRequest('configSnippet must be the snippet object the install pipeline printed ({ mcpServers: { … } })');
  }
  const server = value.mcpServers[serverName];
  if (!server || typeof server !== 'object'
    || typeof server.command !== 'string' || !server.command
    || !Array.isArray(server.args) || server.args.some((a) => typeof a !== 'string')) {
    throw badRequest('configSnippet must carry this server\'s { command, args } entry — the snippet is a connection fact, not decoration');
  }
  return value;
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
  const isLocal = input.kind === 'mcp-local';
  if (isLocal && input.authMode !== 'none') {
    // A local install has no sign-in Helmian holds: the server runs
    // on the person's own machine under their own hand, and the
    // install pipeline's approval was its gate. An auth mode here
    // would promise a connect road that does not exist.
    throw badRequest('an mcp-local entry\'s authMode is "none" — Helmian holds no sign-in for a server on a person\'s own machine');
  }
  const name = requireString(input.name, 'name');
  let trustLabel = input.trustLabel;
  if (input.kind === 'custom') {
    if (trustLabel !== undefined && trustLabel !== 'custom') {
      throw badRequest('custom entries are always trust-labelled "custom" (§2.1)');
    }
    trustLabel = 'custom';
  } else if (isLocal) {
    // The label is earned by the install pipeline — code read,
    // sandbox, human approval — and the baseline fingerprint is its
    // receipt; nothing weaker may be claimed for it, and no other
    // label describes how the entry got here.
    if (trustLabel !== undefined && trustLabel !== 'verified') {
      throw badRequest('an mcp-local entry is trust-labelled "verified" — the install pipeline\'s audit, sandbox, and human approval are its verification');
    }
    trustLabel = 'verified';
  } else if (!CONNECTOR_TRUST_LABELS.includes(trustLabel) || trustLabel === 'custom') {
    throw badRequest('trustLabel must be "verified" or "community" for catalog and helmian-native entries');
  }
  const mcpEndpointUrl = validateEndpointUrl(input.mcpEndpointUrl);
  const vendorConnectorRef = validateVendorConnectorRef(input.vendorConnectorRef);
  // The local facts (sql/080): an mcp-local entry's shape INSTEAD of
  // the endpoint requirement — and every other kind must leave all
  // three empty. The store holds the same line the schema's
  // broker-shape constraint holds, so a bad record is refused here
  // with words, not at the database with a constraint name.
  let installedPath = null;
  let configSnippet = null;
  let baselineFingerprint = null;
  if (isLocal) {
    if (input.brokerMode !== 'helmian') {
      throw badRequest('an mcp-local entry is brokered by Helmian — the install pipeline is Helmian\'s own road onto the machine');
    }
    if (mcpEndpointUrl) throw badRequest('an mcp-local entry has no mcpEndpointUrl — the server runs on a person\'s machine, not at an endpoint');
    if (vendorConnectorRef) throw badRequest('an mcp-local entry carries no vendorConnectorRef');
    installedPath = requireString(input.installedPath ?? '', 'installedPath', { max: 1024 });
    if (!(/^\//.test(installedPath) || /^[A-Za-z]:[\\/]/.test(installedPath))) {
      throw badRequest('installedPath must be an absolute path on the machine that ran the pipeline — a relative path names nothing the record can point at');
    }
    configSnippet = validateConfigSnippet(input.configSnippet, name);
    if (input.baselineFingerprint !== undefined && input.baselineFingerprint !== null) {
      if (typeof input.baselineFingerprint !== 'string' || !HEX64.test(input.baselineFingerprint)) {
        throw badRequest('baselineFingerprint must be the install ledger\'s baseline hash (sha256 hex) when given');
      }
      baselineFingerprint = input.baselineFingerprint;
    }
  } else {
    if (input.installedPath !== undefined && input.installedPath !== null) {
      throw badRequest('installedPath belongs to mcp-local entries only — any other entry is reached at its endpoint or its vendor, never at a path on a machine');
    }
    if (input.configSnippet !== undefined && input.configSnippet !== null) {
      throw badRequest('configSnippet belongs to mcp-local entries only');
    }
    if (input.baselineFingerprint !== undefined && input.baselineFingerprint !== null) {
      throw badRequest('baselineFingerprint belongs to mcp-local entries only — it is the install pipeline\'s baseline, and no other road produces one');
    }
    if (input.brokerMode === 'helmian') {
      if (!mcpEndpointUrl) throw badRequest('a helmian-brokered entry needs its mcpEndpointUrl — Helmian runs the pipe');
      if (vendorConnectorRef) throw badRequest('a helmian-brokered entry carries no vendorConnectorRef');
    } else {
      if (mcpEndpointUrl) throw badRequest('a vendor-brokered entry has no mcpEndpointUrl — Helmian has no pipe for it (§1.5)');
      if (!vendorConnectorRef) throw badRequest('a vendor-brokered entry needs vendorConnectorRef {ref, manageUrl} — the vendor-side identifier and its management link');
    }
  }
  return {
    seatId,
    id,
    kind: input.kind,
    name,
    oneLiner: requireString(input.oneLiner, 'oneLiner', { max: 512 }),
    iconRef: optionalString(input.iconRef, 'iconRef'),
    vendorName: requireString(input.vendorName, 'vendorName'),
    trustLabel,
    category: optionalString(input.category, 'category', { max: 128 }),
    brokerMode: input.brokerMode,
    mcpEndpointUrl,
    vendorConnectorRef,
    installedPath,
    configSnippet,
    baselineFingerprint,
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

  // --------------------------------------- the workspace CUSTOM entry
  // SYNC S2a (see the header): a custom entry is ONE physical row
  // owned by the person its added_by names. These are the only
  // roads that read custom rows across seats. The parameter shapes
  // keep the established positions ($1 names a seat, $2 the entry)
  // even where the seat is deliberately not a filter — the same
  // discipline S1's set reads kept.

  /** Every physical custom row for one entry id in this tenant, any seat, any owner. */
  async function readCustomEntryRows(client, seatId, entryId) {
    const r = await client.query(
      `select * from helmion.connector_entries
        where tenant_id = current_setting('helmion.tenant_id', true) and $1::text is not null and id = $2 and kind = 'custom'
        order by updated_at desc, seat_id asc`,
      [seatId, entryId],
    );
    return r.rows ?? [];
  }

  /** Every physical custom row ONE person owns in this tenant, any seat. */
  async function readCustomEntryRowsForPerson(client, personId) {
    const r = await client.query(
      `select * from helmion.connector_entries
        where tenant_id = current_setting('helmion.tenant_id', true) and kind = 'custom' and added_by = $1
        order by updated_at desc, seat_id asc`,
      [personId],
    );
    return r.rows ?? [];
  }

  // THE ENTRY COLLAPSE RULE (SYNC S2a): several physical custom
  // rows for one (person, entry id) can still exist across seats —
  // a person who created the same custom connector on two agents
  // before the projection existed has two. The workspace entry is
  // the one most recently updated; ties break to the smallest
  // seat id (entries carry no numeric row id, so the seat name is
  // the deterministic tie-break), and every road answers the same
  // row. Losing rows are never shown and never deleted by a read;
  // removal (removeEntry) deletes the whole (id, owner) group.
  function customEntryWinner(rows) {
    let best = null;
    for (const row of rows ?? []) {
      if (!best) { best = row; continue; }
      const t = new Date(row.updated_at ?? 0).getTime();
      const bt = new Date(best.updated_at ?? 0).getTime();
      if (t > bt || (t === bt && String(row.seat_id) < String(best.seat_id))) best = row;
    }
    return best;
  }

  /**
   * The entry a seat's library CARRIES for one id, resolved for one
   * person: the physical row on that seat when there is one (any
   * kind; a custom row only when it is the person's own), else the
   * person's workspace custom entry for that id (its collapse
   * winner), else null. Returns { row, provenanceSeatId } — the
   * row is the physical record; provenanceSeatId is the seat that
   * record lives on. Without a personId no ownership can be ruled,
   * so a physical row answers as-is and the cross-seat search runs
   * over every owner's rows (the workspace-act roads — entry-state,
   * remove — resolve through this shape; the personal roads always
   * pass the person).
   */
  async function readCarriedEntry(client, seatId, entryId, personId = null) {
    const physical = await readEntry(client, seatId, entryId);
    if (physical && physical.kind !== 'custom') return { row: physical, provenanceSeatId: seatId };
    if (physical && (!personId || physical.added_by === personId)) {
      return { row: physical, provenanceSeatId: seatId };
    }
    const rows = await readCustomEntryRows(client, seatId, entryId);
    const candidates = personId ? rows.filter((row) => row.added_by === personId) : rows;
    const winner = customEntryWinner(candidates);
    if (winner) return { row: winner, provenanceSeatId: winner.seat_id };
    return physical && !personId ? { row: physical, provenanceSeatId: seatId } : null;
  }

  // ------------------------------------------------ the workspace SET
  // THE SET COLLAPSE RULE (SYNC S1): the physical table can still
  // hold several rows for one (tenant, person, entry) — a person
  // who connected the same service on two seats before the set
  // existed has two. The SET's row is the one most recently
  // updated; ties (rows stamped inside one transaction) break to
  // the higher row id, so the answer is deterministic on every
  // read and every road. Losing rows are never armed, never shown,
  // and never deleted by a read: they simply stop being the set's
  // row, and their credential references stay in the vault
  // untouched (nothing here ever deletes a vault record — the
  // disconnect road's explicit revoke is the only road that does).
  // A disconnected winner is still the winner: disconnecting from
  // any seat stamps that row newest, so an older connected row on
  // another seat can never resurrect the connection.
  function setWinner(rows) {
    let best = null;
    for (const row of rows ?? []) {
      if (!best) { best = row; continue; }
      const t = new Date(row.updated_at ?? 0).getTime();
      const bt = new Date(best.updated_at ?? 0).getTime();
      if (t > bt || (t === bt && Number(row.id ?? 0) > Number(best.id ?? 0))) best = row;
    }
    return best;
  }

  // Every physical row for one (person, entry) in this tenant, any
  // seat. The seat parameter is carried in the key's own position
  // ($2) for shape consistency with the other connection queries;
  // the set read deliberately does NOT filter on it — filtering by
  // seat is exactly the per-seat ownership this design removes.
  async function readSetRows(client, key) {
    const r = await client.query(
      `select * from helmion.connector_connections
        where tenant_id = current_setting('helmion.tenant_id', true) and person_id = $1 and entry_id = $3
        order by updated_at desc, id desc`,
      [key.personId, key.seatId, key.entryId],
    );
    return r.rows ?? [];
  }

  /** The set's row for (person, entry): the collapse winner, or null. */
  async function readSetConnection(client, key) {
    return setWinner(await readSetRows(client, key));
  }

  // The exact-row WHERE for a resolved set row: writes land on the
  // winner's physical row, addressed by ITS OWN seat (provenance),
  // never by the seat the write happened to arrive on.
  function setKeyOf(row, key) {
    return { personId: key.personId, seatId: row.seat_id, entryId: key.entryId };
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
                     workspace_provisioned = $14, installed_path = $15,
                     config_snippet = $16::jsonb, baseline_fingerprint = $17,
                     updated_at = clock_timestamp()
               where ${whereEntry} returning *`,
              [entry.seatId, entry.id, entry.name, entry.oneLiner, entry.iconRef,
               entry.vendorName, entry.trustLabel, entry.category, entry.mcpEndpointUrl,
               entry.vendorConnectorRef ? JSON.stringify(entry.vendorConnectorRef) : null,
               entry.authMode, entry.clientIdentity, entry.scopesSummary, entry.workspaceProvisioned,
               entry.installedPath, entry.configSnippet ? JSON.stringify(entry.configSnippet) : null,
               entry.baselineFingerprint],
            );
            return entryOf(r.rows[0]);
          }
          if (entry.kind === 'custom') {
            // The duplicate rule, widened by the projection (SYNC
            // S2a): a custom id the SAME person already holds on
            // ANY seat is the one workspace entry — creating it
            // again on another seat is the same never-edited-in-
            // place refusal, not a second entry. (The id is derived
            // from the name on the write road, so this is also the
            // duplicate-NAME rule: its comparison set is now the
            // person's workspace stock, not one seat's. A DIFFERENT
            // person's row with the same id is not a collision for
            // this check — it is walled off by ownership instead;
            // the physical (tenant, seat, id) key still governs two
            // owners creating the same id on the SAME seat, exactly
            // as before.)
            const rows = await readCustomEntryRows(client, entry.seatId, entry.id);
            if (rows.some((row) => row.added_by === entry.addedBy)) {
              throw conflict('a custom connector is never edited in place — remove it and add it again (§1.4)');
            }
          }
          const r = await client.query(
            `insert into helmion.connector_entries
               (tenant_id, seat_id, id, kind, name, one_liner, icon_ref, vendor_name,
                trust_label, category, broker_mode, mcp_endpoint_url, vendor_connector_ref,
                auth_mode, client_identity, scopes_summary, added_by, workspace_provisioned,
                installed_path, config_snippet, baseline_fingerprint, state)
             values (current_setting('helmion.tenant_id', true), $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19::jsonb, $20, 'available')
             returning *`,
            [entry.seatId, entry.id, entry.kind, entry.name, entry.oneLiner, entry.iconRef,
             entry.vendorName, entry.trustLabel, entry.category, entry.brokerMode,
             entry.mcpEndpointUrl, entry.vendorConnectorRef ? JSON.stringify(entry.vendorConnectorRef) : null,
             entry.authMode, entry.clientIdentity, entry.scopesSummary, entry.addedBy,
             entry.workspaceProvisioned, entry.installedPath,
             entry.configSnippet ? JSON.stringify(entry.configSnippet) : null,
             entry.baselineFingerprint],
          );
          return entryOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    /**
     * One seat's entry. A catalog / native / local record written
     * for another seat reads as absent (GATE 1, unchanged). A CUSTOM
     * entry is the person's workspace entry (SYNC S2a): when no
     * physical row sits on this seat, the person's own custom row
     * for the id — wherever it was created — answers as THIS seat's
     * view of the one entry (its seatId is the requesting seat; its
     * provenanceSeatId is where the record lives). Callers that
     * know the person pass { personId } and get only that person's
     * entry; without one, the collapse winner across owners answers
     * (the workspace-act roads' shape).
     */
    async getEntry(tenantId, seatId, entryId, { personId } = {}) {
      const seat = requireString(seatId ?? '', 'seatId', { max: 128 });
      const id = requireString(entryId ?? '', 'entryId', { max: 128 });
      try {
        return await withTenant(tenantId, async (client) => {
          const carried = await readCarriedEntry(client, seat, id, personId ?? null);
          return carried ? entryOf(carried.row, seat) : null;
        });
      } catch (error) {
        if (isMissingTable(error)) return null;
        throw error;
      }
    },

    /**
     * One seat's library. The seat filter is mandatory — there is
     * no cross-seat read of stocked entries. With a personId (SYNC
     * S2a), the person's own CUSTOM entries join the list as this
     * seat's views of their one workspace record (see getEntry),
     * and custom rows on this seat that belong to another person
     * drop out — a person's library never lists another person's
     * customs. Without a personId the physical list answers exactly
     * as before (the catalog refresh's road).
     */
    async listEntries(tenantId, seatId, { personId } = {}) {
      const seat = requireString(seatId ?? '', 'seatId', { max: 128 });
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select * from helmion.connector_entries
              where tenant_id = current_setting('helmion.tenant_id', true) and seat_id = $1
              order by id`,
            [seat],
          );
          const physical = (r.rows ?? []).map((row) => entryOf(row));
          if (!personId) return physical;
          const out = physical.filter((entry) => entry.kind !== 'custom' || entry.addedBy === personId);
          const seen = new Set(out.map((entry) => entry.id));
          const winners = new Map();
          for (const row of await readCustomEntryRowsForPerson(client, personId)) {
            const prev = winners.get(row.id);
            if (!prev || customEntryWinner([prev, row]) === row) winners.set(row.id, row);
          }
          for (const [id, row] of winners) {
            if (seen.has(id)) continue;
            out.push(entryOf(row, seat));
          }
          out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          return out;
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
          let r = await client.query(
            `update helmion.connector_entries set state = $3, updated_at = clock_timestamp()
              where ${whereEntry} returning *`,
            [seat, id, state],
          );
          if (!r.rows[0]) {
            // A workspace custom entry (SYNC S2a) has one physical
            // row, on its provenance seat: the state act lands on
            // THAT row, whichever seat it arrived on, so the one
            // entry reads disabled (or available) everywhere.
            const winner = customEntryWinner(await readCustomEntryRows(client, seat, id));
            if (winner) {
              r = await client.query(
                `update helmion.connector_entries set state = $3, updated_at = clock_timestamp()
                  where ${whereEntry} returning *`,
                [winner.seat_id, id, state],
              );
            }
          }
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
     *
     * For a CUSTOM entry (SYNC S2a) the removal is workspace-wide:
     * the entry is one record for its owner, so removing it through
     * any seat deletes every physical row for (id, owner) — the
     * provenance row and any legacy duplicates — and each row's
     * cascade takes its connections, mirrors, and snapshots with
     * it, so the entry and its set connection are gone everywhere
     * at once and no losing row can resurrect it on the next read.
     * The caller's own rows win resolution when the subject owns a
     * row for the id; another owner's rows for the same id are a
     * different entry and are never deleted by this call.
     */
    async removeEntry(tenantId, seatId, entryId, subject) {
      requireSubject(subject);
      const seat = requireString(seatId ?? '', 'seatId', { max: 128 });
      const id = requireString(entryId ?? '', 'entryId', { max: 128 });
      try {
        return await withTenant(tenantId, async (client) => {
          const physical = await readEntry(client, seat, id);
          let target = physical;
          if (!target || (target.kind === 'custom' && target.added_by !== subject)) {
            const rows = await readCustomEntryRows(client, seat, id);
            const own = customEntryWinner(rows.filter((row) => row.added_by === subject));
            if (own) target = own;
            else if (!target) target = customEntryWinner(rows);
          }
          if (!target) throw notFound('connector entry not found in this seat\'s library');
          if (target.kind !== 'custom') {
            const r = await client.query(
              `delete from helmion.connector_entries where ${whereEntry} returning *`,
              [seat, id],
            );
            if (!r.rows[0]) throw notFound('connector entry not found in this seat\'s library');
            return entryOf(r.rows[0]);
          }
          await client.query(
            `delete from helmion.connector_entries
              where tenant_id = current_setting('helmion.tenant_id', true) and $1::text is not null and id = $2 and kind = 'custom' and added_by = $3
              returning *`,
            [target.seat_id, id, target.added_by],
          );
          return entryOf(target);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    // -------------------------------------------------------- connections

    /**
     * Record a completed connection (§1.3 step 3's landing): the entry
     * must exist in this seat's library, be available, and be
     * helmian-brokered — vendor-brokered entries take mirror records,
     * never token connections. The physical triple (person, seat,
     * entry) stays unique — a second create ON THE SAME SEAT is
     * refused (reconnect is updateConnectionTokens, not a silent
     * overwrite) — but under the workspace SET the new row is stamped
     * newest, so a connect completed on any seat becomes the set's
     * row for the entry: it replaces what every seat reads and arms,
     * and this seat becomes the row's provenance.
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
          // The entry this seat's library carries for the person
          // (SYNC S2a): a stocked entry answers from its own seat;
          // a workspace custom entry answers from its provenance
          // seat, and the connection LANDS on that provenance seat —
          // the connection's foreign key names the entry's physical
          // row (sql/074), and S1's invariant holds: the set row's
          // seat, its credential references' seat segment, and the
          // vault provider id all name the one seat the connection
          // was recorded under. A connect arriving on another seat
          // therefore creates the same single set row a connect on
          // the provenance seat would have created.
          const carried = await readCarriedEntry(client, key.seatId, key.entryId, key.personId);
          if (!carried) throw notFound('connector entry not found in this seat\'s library');
          const entry = carried.row;
          const landingKey = { ...key, seatId: carried.provenanceSeatId };
          if (entry.state !== 'available') throw conflict('this connector is turned off by the workspace owner');
          if (entry.kind === 'mcp-local') {
            throw badRequest('this entry is a local install on a person\'s machine — Helmian holds no connection for it; the install pipeline\'s report is its record');
          }
          if (entry.broker_mode !== 'helmian') {
            throw badRequest('this entry is vendor-brokered — Helmian holds no tokens for it; record a mirror report instead (§1.5)');
          }
          const refs = validateTokenRefs(input, entry, tenantId);
          const existing = await readConnection(client, landingKey);
          if (existing) throw conflict('this person already has a connection for this connector in this seat — v1 is one account per person per connector per seat');
          const r = await client.query(
            `insert into helmion.connector_connections
               (tenant_id, person_id, seat_id, entry_id, account_identity,
                access_token_ref, refresh_token_ref, granted_scopes, posture, state)
             values (current_setting('helmion.tenant_id', true), $1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'connected')
             returning *`,
            [landingKey.personId, landingKey.seatId, landingKey.entryId, accountIdentity,
             refs.accessTokenRef, refs.refreshTokenRef, JSON.stringify(grantedScopes), posture],
          );
          return connectionOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    /**
     * The SET's connection for (person, entry), as seen from one
     * seat: the collapse winner across every seat's physical rows —
     * but only when THIS seat's library carries the entry. A seat
     * that does not carry the entry has no row to show the
     * connection on, and the set does not leak onto it (the §3.4
     * wall). "Carries" is S1's stocked entries PLUS the person's
     * own workspace custom entries (SYNC S2a): a custom entry is
     * carried by every seat for its owner, so its set connection —
     * S1's rule, unchanged — now reaches every seat too. Person and
     * tenant scoping are untouched: another person's rows, and
     * another tenant's, are never in the candidate set.
     */
    async getConnection(tenantId, key) {
      const params = connectionKeyParams(key);
      try {
        return await withTenant(tenantId, async (client) => {
          const carried = await readCarriedEntry(client, params.seatId, params.entryId, params.personId);
          if (!carried) return null;
          return connectionOf(await readSetConnection(client, params));
        });
      } catch (error) {
        if (isMissingTable(error)) return null;
        throw error;
      }
    },

    /**
     * The SET's connections as seen from one seat: one collapsed
     * row per entry (the set winner), for exactly the entries this
     * seat's library carries. Person and seat are both mandatory —
     * the seat names the library whose entries bound the answer,
     * never which physical rows may answer.
     */
    async listConnections(tenantId, filter = {}) {
      const personId = requireString(filter.personId ?? '', 'personId');
      const seatId = requireString(filter.seatId ?? '', 'seatId', { max: 128 });
      try {
        return await withTenant(tenantId, async (client) => {
          const carried = await client.query(
            `select * from helmion.connector_entries
              where tenant_id = current_setting('helmion.tenant_id', true) and seat_id = $1
              order by id`,
            [seatId],
          );
          const carriedIds = new Set((carried.rows ?? []).map((row) => row.id));
          // The person's own workspace custom entries are carried
          // by every seat (SYNC S2a) — their ids join the bound, so
          // the set's row for a custom entry lists from any seat.
          for (const row of await readCustomEntryRowsForPerson(client, personId)) carriedIds.add(row.id);
          if (!carriedIds.size) return [];
          // Every physical row this person holds for ANY entry, in
          // this tenant: the candidate set the collapse rules over.
          // $2 binds the requesting seat (the key's shape, validated
          // above) but is deliberately NOT a filter — filtering by
          // seat is the per-seat ownership the set removes; the
          // carried-entries bound below is the seat's only say.
          const r = await client.query(
            `select * from helmion.connector_connections
              where tenant_id = current_setting('helmion.tenant_id', true) and person_id = $1 and $2::text is not null
              order by entry_id, updated_at desc, id desc`,
            [personId, seatId],
          );
          const byEntry = new Map();
          for (const row of r.rows ?? []) {
            if (!carriedIds.has(row.entry_id)) continue;
            const prev = byEntry.get(row.entry_id);
            if (!prev || setWinner([prev, row]) === row) byEntry.set(row.entry_id, row);
          }
          return [...byEntry.values()].map(connectionOf).sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
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
          // The SET's row is the one renewed, whichever seat the
          // renewal arrives on (SYNC S1): the update lands on the
          // winner's physical row, addressed by its provenance seat.
          const existing = await readSetConnection(client, params);
          if (!existing) throw notFound('connection not found');
          const target = setKeyOf(existing, params);
          const carried = await readCarriedEntry(client, params.seatId, params.entryId, params.personId);
          const entry = carried?.row ?? await readEntry(client, target.seatId, params.entryId);
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
            [target.personId, target.seatId, target.entryId, refs.accessTokenRef, refs.refreshTokenRef, accountIdentity, JSON.stringify(grantedScopes)],
          );
          return connectionOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    /** Posture governs when the Guard asks — never access (§2.2).
     *  The SET's posture: a write from any seat lands on the set's
     *  row (SYNC S1), so every seat reads the new posture. */
    async setPosture(tenantId, key, posture, subject) {
      requireSubject(subject);
      const params = connectionKeyParams(key);
      if (!CONNECTOR_POSTURES.includes(posture)) {
        throw badRequest(`posture must be one of ${CONNECTOR_POSTURES.join(', ')}`);
      }
      try {
        return await withTenant(tenantId, async (client) => {
          const existing = await readSetConnection(client, params);
          if (!existing) throw notFound('connection not found');
          const target = setKeyOf(existing, params);
          const r = await client.query(
            `update helmion.connector_connections set posture = $4, updated_at = clock_timestamp()
              where ${whereConnection} returning *`,
            [target.personId, target.seatId, target.entryId, posture],
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
          const existing = await readSetConnection(client, params);
          if (!existing) throw notFound('connection not found');
          const target = setKeyOf(existing, params);
          const r = await client.query(
            `update helmion.connector_connections set state = 'needs-reconnect', updated_at = clock_timestamp()
              where ${whereConnection} returning *`,
            [target.personId, target.seatId, target.entryId],
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
          const existing = await readSetConnection(client, params);
          if (!existing) throw notFound('connection not found');
          const target = setKeyOf(existing, params);
          const r = await client.query(
            `update helmion.connector_connections set last_used_at = clock_timestamp(), updated_at = clock_timestamp()
              where ${whereConnection} returning *`,
            [target.personId, target.seatId, target.entryId],
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
          // The SET's map (SYNC S1): the write lands on the set's
          // row and merges over ITS map, whichever seat it arrives on.
          const existing = await readSetConnection(client, params);
          if (!existing) throw notFound('connection not found');
          const target = setKeyOf(existing, params);
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
            [target.personId, target.seatId, target.entryId, JSON.stringify(merged)],
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
        // The SET's row is the one disconnected (SYNC S1): a
        // disconnect from any seat flips the winner, stamps it
        // newest, and clears ITS references — so the set reads
        // disconnected from every seat, and no older row on another
        // seat can resurrect it. Losing rows keep their references
        // in the vault untouched; they are simply not the set's row.
        prior = await withTenant(tenantId, async (client) => readSetConnection(client, params));
      } catch (error) { throw storeUnavailable(error); }
      if (!prior) throw notFound('connection not found');
      if (prior.state === 'disconnected') return { connection: connectionOf(prior), revokedRefs: [] };
      const target = setKeyOf(prior, params);
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
            [target.personId, target.seatId, target.entryId],
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
          // The freeze lands on the SET's row (SYNC S1): its
          // snapshot and enable map are the ones every seat arms.
          const existing = await readSetConnection(client, params);
          if (!existing) throw notFound('connection not found');
          const target = setKeyOf(existing, params);
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
            [target.personId, target.seatId, target.entryId, snapshot.id, JSON.stringify(enableMap)],
          );
          return snapshot;
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    /**
     * The connection's FIRST frozen snapshot — its arming baseline
     * (connector-arming-baseline.mjs): snapshot rows are immutable
     * history (a freeze inserts, never updates), so the earliest row
     * is the set every later freeze is compared against. Scoped by
     * the connection key, like getCurrentSnapshot.
     */
    async getFirstSnapshot(tenantId, key) {
      const params = connectionKeyParams(key);
      try {
        return await withTenant(tenantId, async (client) => {
          const existing = await readSetConnection(client, params);
          if (!existing) return null;
          const snap = await client.query(
            `select * from helmion.connector_snapshots where connection_id = $1 order by id asc limit 1`,
            [existing.id],
          );
          return snapshotOf(snap.rows[0]);
        });
      } catch (error) {
        if (isMissingTable(error)) return null;
        throw error;
      }
    },

    /** The snapshot the SET's connection is currently running, or null. Scoped by the connection key. */
    async getCurrentSnapshot(tenantId, key) {
      const params = connectionKeyParams(key);
      try {
        return await withTenant(tenantId, async (client) => {
          const existing = await readSetConnection(client, params);
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

    // ------------------------------------------------- tenant summaries
    // The Level 1 counts read's store shape (connector-library-read
    // .mjs readSeatCounts): the caller's OWN tenant, the caller's OWN
    // person, every seat at once — the three listings the per-seat
    // reads would make, made once each for the whole tenant instead
    // of once per seat (the /seats route otherwise pays a full
    // library read per seat to produce two counts per seat). These
    // are SUMMARY reads, deliberately narrow:
    //   · tenant and person are fixed by the caller exactly as on
    //     the per-seat reads — §3.4 isolation is across tenants and
    //     persons, and neither can be selected here either;
    //   · entries and mirrors are never mixed across seats: every
    //     row carries its seatId and the reader splits by it — a
    //     record written for one seat is counted for that seat
    //     alone. CONNECTIONS carry their provenance seatId the same
    //     way, but under the workspace SET (SYNC S1) the reader
    //     collapses them per entry (most recently updated wins)
    //     and counts the winner for every seat whose library
    //     carries that entry;
    //   · the columns are the minimum the counts join needs (ids,
    //     kind, broker mode, state — plus, for connections, the
    //     collapse fields updated_at / id, and for entries the
    //     S2a fields added_by / updated_at) — no descriptive row
    //     data, no account identities, and never a token reference.
    // Row-level reads (listEntries / listConnections / listMirrors)
    // remain the only road to a seat's actual rows.

    /**
     * Every entry in the tenant's libraries, seat-tagged, summary
     * fields only — plus, for SYNC S2a, addedBy and updatedAt: the
     * counts reader rules a person's custom entries from them (the
     * owner the entry belongs to, and the ENTRY COLLAPSE RULE's
     * input when legacy duplicates exist). The summary stays
     * descriptive-field-free as before.
     */
    async listEntriesForTenant(tenantId) {
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select seat_id, id, kind, broker_mode, state from helmion.connector_entries
              where tenant_id = current_setting('helmion.tenant_id', true)
              order by seat_id, id`,
          );
          // The S2a enrichment: added_by / updated_at for the same
          // rows, read as its own query so the established summary
          // select above keeps its exact shape. A store-shaped fake
          // that cannot answer it leaves the fields null, and the
          // counts reader treats an unattributed custom row the
          // legacy way (counted on its physical seat) — the fields
          // are an addition, never a new requirement.
          let enrichment = new Map();
          try {
            const extra = await client.query(
              `select seat_id, id, added_by, updated_at from helmion.connector_entries
                where tenant_id = current_setting('helmion.tenant_id', true)`,
            );
            enrichment = new Map((extra.rows ?? []).map((row) => [`${row.seat_id}|${row.id}`, row]));
          } catch { /* unattributed is a readable answer (see above) */ }
          return r.rows.map((row) => {
            const extra = enrichment.get(`${row.seat_id}|${row.id}`);
            return {
              seatId: row.seat_id, id: row.id, kind: row.kind,
              brokerMode: row.broker_mode, state: row.state,
              addedBy: extra?.added_by ?? row.added_by ?? null,
              updatedAt: extra?.updated_at ?? row.updated_at ?? null,
            };
          });
        });
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },

    /**
     * One person's connections across the tenant's seats, summary
     * fields only — plus, under the workspace SET (SYNC S1), the two
     * fields the counts reader needs to run the SET COLLAPSE RULE
     * over these rows: updatedAt and the row id (the deterministic
     * winner per entry is the most recently updated, ties to the
     * higher id). seatId here is the row's PROVENANCE seat; the
     * reader, not this listing, decides which seats a winning row
     * counts for (every seat whose library carries the entry).
     */
    async listConnectionsForTenant(tenantId, filter = {}) {
      const personId = requireString(filter.personId ?? '', 'personId');
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select seat_id, entry_id, state, updated_at, id from helmion.connector_connections
              where tenant_id = current_setting('helmion.tenant_id', true) and person_id = $1
              order by seat_id, entry_id`,
            [personId],
          );
          return r.rows.map((row) => ({
            seatId: row.seat_id, entryId: row.entry_id, state: row.state,
            updatedAt: row.updated_at ?? null, id: row.id ?? null,
          }));
        });
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },

    /** One person's mirror records across the tenant's seats, summary fields only. */
    async listMirrorsForTenant(tenantId, filter = {}) {
      const personId = requireString(filter.personId ?? '', 'personId');
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select seat_id, entry_id, reported_state from helmion.connector_mirrors
              where tenant_id = current_setting('helmion.tenant_id', true) and person_id = $1
              order by seat_id, entry_id`,
            [personId],
          );
          return r.rows.map((row) => ({ seatId: row.seat_id, entryId: row.entry_id, reportedState: row.reported_state }));
        });
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },
  };
}
