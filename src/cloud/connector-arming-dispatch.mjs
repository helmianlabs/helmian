// Connector arming — the DISPATCH half (Mirror M3, bite G4;
// m3-github/DESIGN.md §2.2 + §4.1(2)).
//
// The plus menu's switches persist a channel's armed set
// (config.armedConnectors, bite A1+A2), and a message carries the
// same set as metadata.connectors — but until this module nothing
// on the turn path read either. This is the reader: when
// envoy-mesh.mjs hands out a work item for a human message, it
// resolves the armed pairs for the seats due on that message
// against the connector library, HERE, cloud-side, where the store
// and the credential service live — the runner (a customer's PC
// bridge) has no road to either and must not grow one.
//
// Each resolved pair becomes one ARMING RECORD:
//
//   { seatId, entryId, state,
//     reason?, detail?,                      // non-connected records
//     entryName?, endpointUrl?, authMode?,   // the entry's own facts
//     localInstall?,                         // mcp-local entries: the
//                                            // install's facts instead
//                                            // of an endpoint (sql/080)
//     accountIdentity?, posture?,            // connected records
//     snapshotTools?: [{ name, annotation, inputSchemaHash }],
//     toolEnableMap?, accessToken?, tokenSource? }
//
// Records ride the work item under `connectorConnections` — the
// field bin/pc-bridge.mjs already forwards into the bridge child's
// turn request — and src/agent/connector-arming.mjs builds the
// turn's arming seam from them. The 4R2-era comment on that field
// describes vault REFERENCES riding the item for a child-side
// minter; the minter came out with the Scribe cut, and M3's design
// supersedes the shape: the token is minted HERE, at dispatch, and
// rides in memory for the one turn, never written to the library,
// never logged (the Pattern-A minted token's discipline, §2.2).
//
// Token resolution order (DESIGN §1.1/§2.2): the person's own
// connection first (its vault reference resolved through the
// credential service); the operator token where one exists for the
// provider (today: GITHUB_TOKEN for GitHub); none — the record
// rides state-only on the token side (accessToken null) and the
// runner decides honestly from the entry's auth mode.
//
// A connection with no frozen snapshot gets one at first arm —
// the §4.1(2) backstop: list the server's tools with the resolved
// token, freeze them through the store, and arm on the frozen set.
// A failed backstop is a 'freeze-failed' record, never an unfrozen
// turn. Per-pair DOMAIN outcomes (no entry, no connection, needs
// reconnect, vendor-brokered, freeze failed) are records; INFRA
// failures (the store or the credential service throwing) propagate
// to the caller, whose discipline is the skills road's: no arming
// field on the work item at all, dispatch unchanged.
//
// CUSTOM ENTRIES PASS A GATE FIRST (pipeline map G1,
// connector-custom-gate.mjs): an entry a person added carries no
// catalog provenance, so before any connection or token is read the
// pair must show the gate's verified receipt — a null-credential
// probe recorded in the tool-connections store. No receipt (or a
// failed one) is a 'not-gated' record; the token road is never
// walked for an ungated entry. And the backstop above does NOT
// apply to custom entries: their snapshot must be the one frozen
// from the gate probe's own list at connect time — freezing
// whatever the server lists at arm time was the hole's second half.
// A gated custom entry with no snapshot is a 'freeze-failed' record.
//
// MCP-LOCAL ENTRIES NEVER ARM FROM HERE (sql/080): an installed
// stdio server lives on a person's own machine. This dispatch is
// cloud-side and holds no road to that machine; the entry has no
// endpoint to list tools from, no connection, and no frozen
// snapshot a cloud freeze could have taken — and the runner pipe
// (attachments.mjs) arms connector toggles only through a remote
// endpoint or the Pattern-A hand-off, never by starting a local
// server. Arming one would be a silent fiction, so the pair
// resolves to a 'local-only' record naming exactly that, before
// the connection or any token is read. The record still carries
// the entry's local facts (installed path, config snippet,
// baseline fingerprint) — the facts a runner ON that machine will
// need when a road exists that can start the server and freeze its
// tools there.

import { randomUUID } from 'node:crypto';
import { createConnectorLibraryStore } from './connector-library.mjs';
import { createCredentialConnectClient } from './credential-connect.mjs';
import { createMcpPromptsClient } from './connector-mcp-prompts.mjs';
import { createToolConnectionsStore } from './tool-connections.mjs';
import { classifyCustomGate, customGateKey } from './connector-custom-gate.mjs';

// sanitizeArmedConnectors caps the stored set at MAX_MESSAGE_CONNECTORS
// (envoy-agents.mjs); the resolved set keeps the same ceiling.
export const ARMING_PAIR_CAP = 16;

// Mesh provider id → connector-library seat id. The two vocabularies
// agree everywhere but one: the mesh routes ChatGPT as 'openai',
// the library shelves it as 'chatgpt' (envoy-faces.mjs carries the
// same single exception). Custom agents resolve through their
// engine's provider first (below).
const MESH_TO_LIBRARY_SEAT = Object.freeze({ openai: 'chatgpt' });

export function librarySeatForDueProvider(provider, customAgents = []) {
  const custom = (customAgents ?? []).find((a) => (a?.handle || a?.id) === provider);
  const engine = custom?.provider ?? provider;
  return MESH_TO_LIBRARY_SEAT[engine] ?? engine;
}

/**
 * The pairs one work item resolves: the union of the channel's
 * standing armed set and the message's own toggles, deduped,
 * filtered to the library seats due on the message — another
 * seat's connectors are not this item's business. Pure.
 */
export function armingPairsForDispatch({ armedConnectors = [], messageConnectors = [], dueProviders = [], customAgents = [] } = {}) {
  const dueSeats = new Set((dueProviders ?? []).map((p) => librarySeatForDueProvider(p, customAgents)));
  const out = [];
  const seen = new Set();
  for (const pair of [...(armedConnectors ?? []), ...(messageConnectors ?? [])]) {
    const seatId = typeof pair?.seatId === 'string' && pair.seatId ? pair.seatId : null;
    const entryId = typeof pair?.entryId === 'string' && pair.entryId ? pair.entryId : null;
    if (!seatId || !entryId || !dueSeats.has(seatId)) continue;
    const key = `${seatId}|${entryId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ seatId, entryId });
    if (out.length >= ARMING_PAIR_CAP) break;
  }
  return out;
}

// The credential service answers a resolve with the stored bundle:
// a bare string, or an object carrying the token under accessToken
// or apiKey (the write route's own extraction, connector-library-
// write-route.mjs's prompts road — one vocabulary for both).
function tokenFromCredential(credential) {
  if (typeof credential === 'string' && credential) return credential;
  if (credential && typeof credential === 'object') {
    if (typeof credential.accessToken === 'string' && credential.accessToken) return credential.accessToken;
    if (typeof credential.apiKey === 'string' && credential.apiKey) return credential.apiKey;
  }
  return null;
}

// Which provider an entry's operator token would belong to. Only
// GitHub has an operator token today (DESIGN §1.1, Road A); every
// other entry resolves from the person's connection or not at all.
function operatorProviderKeyFor(entry) {
  return entry?.id === 'helmian-github' || entry?.id === 'github' ? 'github' : null;
}

// The actor the token resolve below runs as. The vault demands a
// full actor context on every call (credential-vault.mjs's
// requireActor: tenantId, actorSubject, actorRole, sessionId,
// requestId — the omission that broke the library write route's
// stores, fixed there by naming the person, whose own click it
// was). This call is NOT the person's click: it is the cloud
// dispatch arming a seat for a turn, resolving the person's stored
// credential on the system's own initiative. Naming the person
// would write a false audit line, so the resolve names the system
// actor it is — the codebase's system-actor shape: a namespaced
// subject ('helmion:signed-session-policy',
// tenant-action-policy.mjs) in the credential service's system
// role — its audit records the box's own executor resolving as
// actorRole 'device'. The connection's owner is not lost: the
// reference and providerId name whose credential it is, and the
// arming record stays keyed to the person throughout. The dispatch
// carries no session or request ids of its own, so both are minted
// per the audit convention for actor shapes that carry none
// (org-invites.mjs): one sessionId per dispatch run, one requestId
// per resolve.
export const ARMING_ACTOR_SUBJECT = 'helmion:connector-arming';

export function armingActorContext({ tenantId, sessionId = randomUUID(), requestId = randomUUID() } = {}) {
  return { tenantId, actorSubject: ARMING_ACTOR_SUBJECT, actorRole: 'device', sessionId, requestId };
}

/**
 * Resolve ONE armed pair into its arming record. Domain outcomes
 * are records (see the header); store/credential throws propagate.
 */
export async function resolveArmingRecord({ store, credentials = null, listTools, operatorTokens = {}, toolConnections = null, tenantId, personId, seatId, entryId, actorContext = null }) {
  const base = { seatId, entryId };
  const key = { personId, seatId, entryId };
  const entry = await store.getEntry(tenantId, seatId, entryId);
  if (!entry) {
    return { ...base, state: 'unknown-entry', reason: 'unknown-entry', detail: 'it is not in this seat\u2019s library' };
  }
  const facts = {
    entryName: entry.name, endpointUrl: entry.mcpEndpointUrl ?? null, authMode: entry.authMode,
    // An mcp-local entry's facts are its local ones (sql/080): no
    // endpoint exists, so the record carries where the install
    // lives and how it starts — the facts a runner on that machine
    // will need, and the reason this record cannot arm from here.
    ...(entry.kind === 'mcp-local'
      ? {
        localInstall: {
          installedPath: entry.installedPath ?? null,
          configSnippet: entry.configSnippet ?? null,
          baselineFingerprint: entry.baselineFingerprint ?? null,
        },
      }
      : {}),
  };
  if (entry.state !== 'available') {
    return { ...base, ...facts, state: 'entry-disabled', reason: 'entry-disabled', detail: 'the workspace owner has turned it off' };
  }
  if (entry.kind === 'mcp-local') {
    return {
      ...base, ...facts, state: 'local-only', reason: 'local-only',
      detail: 'it is a local install on a person\u2019s own machine — no turn away from that machine can reach it, and no tool list has been frozen from that machine, so its tools cannot arm from here',
    };
  }
  if (entry.brokerMode !== 'helmian' || !entry.mcpEndpointUrl) {
    return { ...base, ...facts, state: 'vendor-brokered', reason: 'vendor-brokered', detail: `it is brokered by ${entry.vendorName}, not by Helmian` };
  }
  // The custom-entry gate (see the header): the verified receipt is
  // demanded BEFORE the connection or any token is read — an
  // ungated entry's credential is never resolved for a turn. A
  // missing gate store fails closed the same way: the gate cannot
  // be proven, so the entry cannot arm.
  if (entry.kind === 'custom') {
    const gateRow = toolConnections && typeof toolConnections.get === 'function'
      ? await toolConnections.get(tenantId, customGateKey(seatId, entryId))
      : null;
    const gate = classifyCustomGate(gateRow);
    if (!gate.passed) {
      return { ...base, ...facts, state: 'not-gated', reason: gate.reason, detail: gate.detail };
    }
  }
  const connection = await store.getConnection(tenantId, key);
  if (!connection) {
    return { ...base, ...facts, state: 'not-connected', reason: 'not-connected', detail: 'it is not connected for this seat' };
  }
  if (connection.state !== 'connected') {
    return { ...base, ...facts, state: connection.state, reason: `connection-${connection.state}`, detail: `its connection is ${connection.state}` };
  }

  // The turn's token, in the design's order (§1.1/§2.2): the
  // person's own connection, then the operator's token for the
  // provider, then none.
  let accessToken = null;
  let tokenSource = null;
  if (entry.authMode !== 'none' && connection.accessTokenRef && credentials) {
    const resolved = await credentials.resolveVaultCredential({
      ...(actorContext ?? armingActorContext({ tenantId })),
      providerId: `connector.${seatId}.${entryId}`,
      credentialReference: connection.accessTokenRef,
      reasonClass: 'provider_call',
    });
    const value = resolved?.accepted ? tokenFromCredential(resolved.credential) : null;
    if (value) { accessToken = value; tokenSource = 'connection'; }
  }
  if (!accessToken && entry.authMode !== 'none') {
    const providerKey = operatorProviderKeyFor(entry);
    const operator = providerKey ? operatorTokens?.[providerKey] : null;
    if (typeof operator === 'string' && operator) { accessToken = operator; tokenSource = 'operator'; }
  }

  // The frozen set the turn may run from — or the first-arm
  // backstop that takes it (§4.1(2)). Custom entries are the one
  // exception to the backstop: their frozen set must be the gate
  // probe's list, frozen at connect time — a missing one is a
  // freeze-failed record, never a fresh list taken at arm time.
  let snapshot = await store.getCurrentSnapshot(tenantId, key);
  let settled = connection;
  if (!snapshot && entry.kind === 'custom') {
    return { ...base, ...facts, state: 'freeze-failed', reason: 'freeze-failed', detail: 'it passed its safety check but has no frozen tool list from that check yet, so this turn cannot run its tools' };
  }
  if (!snapshot) {
    if (!accessToken && entry.authMode !== 'none') {
      return { ...base, ...facts, state: 'freeze-failed', reason: 'freeze-failed', detail: 'it has no frozen tool list yet, and no sign-in could be resolved to take one' };
    }
    try {
      const listed = await listTools({ endpoint: entry.mcpEndpointUrl, accessToken });
      if (!listed?.supported || !Array.isArray(listed.tools)) throw new Error('the server did not answer a tools list');
      snapshot = await store.freezeSnapshot(tenantId, key, listed.tools, personId);
      settled = (await store.getConnection(tenantId, key)) ?? connection;
    } catch (error) {
      return { ...base, ...facts, state: 'freeze-failed', reason: 'freeze-failed', detail: `its tool list could not be frozen for this turn (${error.message})` };
    }
  }

  return {
    ...base,
    ...facts,
    state: 'connected',
    accountIdentity: settled.accountIdentity ?? null,
    posture: settled.posture ?? 'ask',
    snapshotTools: (snapshot.tools ?? []).map((tool) => ({
      name: tool.name,
      annotation: tool.annotation,
      inputSchemaHash: tool.inputSchemaHash,
    })),
    toolEnableMap: settled.toolEnableMap ?? {},
    accessToken,
    tokenSource,
  };
}

/**
 * Resolve a work item's whole pair set. Dependencies are injectable
 * (envoy-mesh passes its armingReadImpl in tests); the defaults are
 * the production roads: the library store over the mesh's pool, the
 * credential-connect client from the environment, the prompts wire
 * client's listTools, and the operator token from the environment.
 */
export async function resolveDispatchArming({ pool, tenantId, personId, pairs, store = null, credentials = undefined, listTools = null, operatorTokens = null, toolConnections = undefined } = {}) {
  const libraryStore = store ?? createConnectorLibraryStore(pool);
  const credentialClient = credentials !== undefined ? credentials : createCredentialConnectClient();
  // The custom-entry gate's store: the same pool the library reads
  // from. Consulted only for custom entries (see resolveArmingRecord).
  const gateStore = toolConnections !== undefined ? toolConnections : (pool ? createToolConnectionsStore(pool) : null);
  const wire = createMcpPromptsClient({});
  const lister = listTools ?? (({ endpoint, accessToken }) => wire.listTools({ endpoint, accessToken }));
  const operators = operatorTokens ?? { github: String(process.env.GITHUB_TOKEN ?? '').trim() || null };
  // One arming run is one session of the dispatch's system actor;
  // each pair's resolve is its own request under it.
  const sessionId = randomUUID();
  const records = [];
  for (const pair of pairs ?? []) {
    records.push(await resolveArmingRecord({
      store: libraryStore,
      credentials: credentialClient,
      listTools: lister,
      operatorTokens: operators,
      toolConnections: gateStore,
      tenantId,
      personId,
      seatId: pair.seatId,
      entryId: pair.entryId,
      actorContext: armingActorContext({ tenantId, sessionId }),
    }));
  }
  return records;
}
