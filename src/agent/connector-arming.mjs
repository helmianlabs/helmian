// Connector arming — the RUNNER half (Mirror M3, bite G4;
// m3-github/DESIGN.md §2.2).
//
// Dispatch (src/cloud/connector-arming-dispatch.mjs) resolved the
// message's armed connectors cloud-side, where the connector
// library and the credential service live, and the arming records
// rode the work item into this runner as the turn request's
// `connectorConnections`. This module turns those records into the
// arming seam attachments.mjs consumes:
//
//   recordFor({seatId, entryId})    → the pair's full record — the
//     runner-hosted pipe's input (posture, frozen tool set, enable
//     map, token). This is the face that makes a turn real in G4.
//   connectionFor / mintAccessToken → the pre-G4 Pattern-A faces,
//     answered from the same records, so a seam built here still
//     serves the older consumer shape honestly (the state the
//     record carries, the token dispatch already minted).
//   approveCall({tool, args})       → the posture approver: the
//     bridge's own ask-mode approver (approval.mjs), the ONLY way
//     a gated call gets approved (DESIGN §3). No approver wired =
//     false, always — fail closed, the tools.mjs law.
//
// Records are shape-checked at this door (sanitizeArmingRecords):
// the turn request crosses a process boundary, and a malformed
// record must degrade to "not this turn's record", never to a
// guessed-at arm. An empty record set builds a NULL seam — a turn
// with no arming table keeps the pre-G4 outcome exactly
// (attachments.mjs records every toggle 'arming-not-wired').

import { ALLOW_ONCE, ALLOW_SESSION } from './approval.mjs';

const ARMING_POSTURES = new Set(['ask', 'read', 'low-risk', 'all']);

/**
 * Shape-check dispatch's arming records at the runner's door.
 * Anything unusable is dropped, never repaired by guessing: a
 * record without a seat, an entry, or a state is not a record.
 * The token survives only as a non-empty string; the posture only
 * as one of the four the Manage face offers (anything else reads
 * back as 'ask', the store's own default — fail closed).
 */
export function sanitizeArmingRecords(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const record of input) {
    if (!record || typeof record !== 'object') continue;
    const seatId = typeof record.seatId === 'string' && record.seatId ? record.seatId : null;
    const entryId = typeof record.entryId === 'string' && record.entryId ? record.entryId : null;
    const state = typeof record.state === 'string' && record.state ? record.state : null;
    if (!seatId || !entryId || !state) continue;
    out.push({
      seatId,
      entryId,
      state,
      ...(typeof record.reason === 'string' && record.reason ? { reason: record.reason } : {}),
      ...(typeof record.detail === 'string' && record.detail ? { detail: record.detail.slice(0, 300) } : {}),
      ...(typeof record.entryName === 'string' && record.entryName ? { entryName: record.entryName } : {}),
      ...(typeof record.endpointUrl === 'string' && record.endpointUrl ? { endpointUrl: record.endpointUrl } : {}),
      // An mcp-local record's local facts (sql/080), shape-checked
      // like everything else at this door: the installed path and
      // baseline fingerprint as strings, the config snippet as the
      // object the pipeline printed. They ride so a runner on the
      // install's own machine can see what would be started there;
      // the record's state ('local-only') is what rules the turn.
      ...(record.localInstall && typeof record.localInstall === 'object' && !Array.isArray(record.localInstall)
        ? {
          localInstall: {
            installedPath: typeof record.localInstall.installedPath === 'string' && record.localInstall.installedPath ? record.localInstall.installedPath : null,
            configSnippet: record.localInstall.configSnippet && typeof record.localInstall.configSnippet === 'object' && !Array.isArray(record.localInstall.configSnippet)
              ? record.localInstall.configSnippet
              : null,
            baselineFingerprint: typeof record.localInstall.baselineFingerprint === 'string' && record.localInstall.baselineFingerprint ? record.localInstall.baselineFingerprint : null,
          },
        }
        : {}),
      ...(typeof record.authMode === 'string' && record.authMode ? { authMode: record.authMode } : {}),
      ...(typeof record.accountIdentity === 'string' && record.accountIdentity ? { accountIdentity: record.accountIdentity } : {}),
      posture: ARMING_POSTURES.has(record.posture) ? record.posture : 'ask',
      snapshotTools: (Array.isArray(record.snapshotTools) ? record.snapshotTools : [])
        .filter((tool) => tool && typeof tool.name === 'string' && tool.name)
        .map((tool) => ({
          name: tool.name,
          annotation: typeof tool.annotation === 'string' ? tool.annotation : 'undeclared',
          ...(typeof tool.inputSchemaHash === 'string' && tool.inputSchemaHash ? { inputSchemaHash: tool.inputSchemaHash } : {}),
        })),
      toolEnableMap: record.toolEnableMap && typeof record.toolEnableMap === 'object' && !Array.isArray(record.toolEnableMap)
        ? Object.fromEntries(Object.entries(record.toolEnableMap).filter(([, value]) => typeof value === 'boolean'))
        : {},
      accessToken: typeof record.accessToken === 'string' && record.accessToken ? record.accessToken : null,
      tokenSource: typeof record.tokenSource === 'string' && record.tokenSource ? record.tokenSource : null,
    });
  }
  return out;
}

/**
 * Build the turn's arming seam from dispatch's records. Returns
 * null for an empty set — the caller passes the null on, and the
 * turn behaves exactly as it did before G4.
 *
 * `approver` is the bridge's ask-mode approver
 * (approval.mjs's broker): approveCall forwards the call to it
 * with the tool's turn name and arguments and reads its decision
 * word; anything but ALLOW_ONCE / ALLOW_SESSION is a refusal, and
 * a thrown approver is a refusal too.
 */
export function buildConnectorArming(records, { approver = null, workspace = null, permissionMode = null } = {}) {
  const clean = sanitizeArmingRecords(records);
  if (!clean.length) return null;
  const byKey = new Map(clean.map((record) => [`${record.seatId}|${record.entryId}`, record]));
  const find = ({ seatId, entryId } = {}) => byKey.get(`${seatId}|${entryId}`) ?? null;
  return {
    recordFor: find,

    // The Pattern-A faces, answered from the records: the state is
    // the state dispatch resolved; the token is the one dispatch
    // minted. A pair with no record answers null / not-ok, exactly
    // as an unwired seam's honest outcomes did.
    async connectionFor({ seatId, entryId } = {}) {
      const record = find({ seatId, entryId });
      if (!record) return null;
      return { state: record.state, refreshTokenRef: null, accountIdentity: record.accountIdentity ?? null };
    },
    async mintAccessToken({ seatId, entryId } = {}) {
      const record = find({ seatId, entryId });
      if (record?.accessToken) return { ok: true, accessToken: record.accessToken };
      return { ok: false, code: 'token-unavailable', reason: 'no sign-in token rode this turn\u2019s dispatch.' };
    },

    // The posture gate's approver (DESIGN §3): true only on an
    // explicit allow from the bridge's approval broker.
    async approveCall({ tool, args } = {}) {
      if (typeof approver !== 'function') return false;
      try {
        const decision = await approver({ tool, args: args ?? {}, workspace, permissionMode });
        return decision === ALLOW_ONCE || decision === ALLOW_SESSION;
      } catch {
        return false;
      }
    },
  };
}
