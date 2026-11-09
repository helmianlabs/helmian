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

import { createConnectorLibraryStore } from './connector-library.mjs';
import { createCredentialConnectClient } from './credential-connect.mjs';
import { createMcpPromptsClient } from './connector-mcp-prompts.mjs';

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

/**
 * Resolve ONE armed pair into its arming record. Domain outcomes
 * are records (see the header); store/credential throws propagate.
 */
export async function resolveArmingRecord({ store, credentials = null, listTools, operatorTokens = {}, tenantId, personId, seatId, entryId }) {
  const base = { seatId, entryId };
  const key = { personId, seatId, entryId };
  const entry = await store.getEntry(tenantId, seatId, entryId);
  if (!entry) {
    return { ...base, state: 'unknown-entry', reason: 'unknown-entry', detail: 'it is not in this seat\u2019s library' };
  }
  const facts = { entryName: entry.name, endpointUrl: entry.mcpEndpointUrl ?? null, authMode: entry.authMode };
  if (entry.state !== 'available') {
    return { ...base, ...facts, state: 'entry-disabled', reason: 'entry-disabled', detail: 'the workspace owner has turned it off' };
  }
  if (entry.brokerMode !== 'helmian' || !entry.mcpEndpointUrl) {
    return { ...base, ...facts, state: 'vendor-brokered', reason: 'vendor-brokered', detail: `it is brokered by ${entry.vendorName}, not by Helmian` };
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
      tenantId,
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
  // backstop that takes it (§4.1(2)).
  let snapshot = await store.getCurrentSnapshot(tenantId, key);
  let settled = connection;
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
export async function resolveDispatchArming({ pool, tenantId, personId, pairs, store = null, credentials = undefined, listTools = null, operatorTokens = null } = {}) {
  const libraryStore = store ?? createConnectorLibraryStore(pool);
  const credentialClient = credentials !== undefined ? credentials : createCredentialConnectClient();
  const wire = createMcpPromptsClient({});
  const lister = listTools ?? (({ endpoint, accessToken }) => wire.listTools({ endpoint, accessToken }));
  const operators = operatorTokens ?? { github: String(process.env.GITHUB_TOKEN ?? '').trim() || null };
  const records = [];
  for (const pair of pairs ?? []) {
    records.push(await resolveArmingRecord({
      store: libraryStore,
      credentials: credentialClient,
      listTools: lister,
      operatorTokens: operators,
      tenantId,
      personId,
      seatId: pair.seatId,
      entryId: pair.entryId,
    }));
  }
  return records;
}
