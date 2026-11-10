// The install pipeline → connector library bridge (pipeline map §3,
// gap G2, direction 1): when the pipeline reaches INSTALLED, it
// produces a LIBRARY-ENTRY REPORT — the facts a plus-menu row would
// be built from — and the report travels to the library through the
// connector-library write route's `entries/install-report` action.
//
// THE TWO-MACHINE HONESTY this module is shaped by: the pipeline
// runs on a person's machine and its ledger is a local directory;
// the connector library is cloud-side. The report is therefore a
// DOCUMENT, carried over the existing authenticated write road —
// never a pretence that the two stores share a disk.
//
// What the report carries: the entry facts (kind 'mcp-local',
// brokerMode 'helmian', the derived entry id), the connection facts
// a local install honestly has (the installed path and the config
// snippet the pipeline already prints — there is no endpoint URL; a
// stdio server on the person's machine has none), and the ledger's
// BASELINE FINGERPRINT (the approved code + permission-surface hash
// from mcp-install-ledger.mjs), which is the snapshot-baseline seed
// the map asks for.
//
// What the report canNOT carry, and never claims: a probe receipt.
// recordProbeReceipt (tool-connections.mjs) demands a tools/list
// method and a tool count, and no tools/list has ever been run
// against an installed stdio server by the cloud — the pipeline's
// sandbox stage observes behaviour (hosts, subprocesses, writes); it
// does not list tools, and the cloud cannot reach a stdio server on
// someone's machine to list them itself. The receiving end therefore
// registers INTENT only ('registered', never 'verified'), exactly
// like the custom-entry gate's step 1. The entry id is DERIVED from
// the server name (below), never trusted from the wire: every reader
// computes the same id from the name alone, the customGateServiceId
// discipline.

import { createHash } from 'node:crypto';

export const MCP_INSTALL_REPORT_FORMAT = 'helmian-mcp-install-report';
export const MCP_INSTALL_REPORT_VERSION = 1;
export const MCP_LOCAL_KIND = 'mcp-local';
export const MCP_LOCAL_BROKER_MODE = 'helmian';

// Field names that would mean the report is carrying a credential
// VALUE. Refused by name at validation, the same discipline as the
// stores the report lands beside.
const CREDENTIAL_VALUE_KEYS = Object.freeze([
  'accessToken', 'refreshToken', 'token', 'secret', 'password', 'apiKey', 'api_key', 'credential', 'value',
]);

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function slugify(serverName) {
  return String(serverName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'server';
}

/**
 * The library entry id for a pipeline-installed server:
 * `mcp-local-<slug>`, shortened to a hashed form when it would pass
 * the tool-connections service_id cap (64, sql/061) — the id doubles
 * as that service id on the receiving end, so the cap is the id's
 * own cap. Deterministic: the same name always derives the same id.
 */
export function mcpLocalEntryId(serverName) {
  const direct = `mcp-local-${slugify(serverName)}`;
  if (direct.length <= 64) return direct;
  return `mcp-local-${createHash('sha256').update(String(serverName ?? ''), 'utf8').digest('hex').slice(0, 48)}`;
}

/** The tool-connections key an install report registers under (gate-key shape). */
export function mcpLocalToolConnectionKey(seatId, serverName) {
  return { scopeKind: 'workspace', scopeId: String(seatId ?? ''), serviceId: mcpLocalEntryId(serverName) };
}

/**
 * Build the library-entry report from a finished pipeline report.
 * Only an INSTALLED pipeline produces one — anything short of
 * installed exits the pipeline with finalDecision set to something
 * else, and a report for a server that was never installed would be
 * a false record. Returns null in that case, deliberately.
 */
export function buildInstallLibraryReport(report) {
  if (!report || report.finalDecision !== 'installed') return null;
  const baseline = report.stages?.baseline ?? null;
  const approval = report.stages?.approval ?? null;
  return {
    format: MCP_INSTALL_REPORT_FORMAT,
    version: MCP_INSTALL_REPORT_VERSION,
    kind: MCP_LOCAL_KIND,
    brokerMode: MCP_LOCAL_BROKER_MODE,
    serverName: report.serverName,
    entryId: mcpLocalEntryId(report.serverName),
    name: report.serverName,
    installedPath: report.installedPath,
    configSnippet: report.configSnippet,
    baseline: baseline ? {
      fingerprint: baseline.fingerprint,
      filesHash: baseline.filesHash,
      permissionsHash: baseline.permissionsHash,
      fileCount: baseline.fileCount,
      permissions: baseline.permissions,
      approvedAt: baseline.approvedAt ?? null,
    } : null,
    declaredTools: [...(report.declared?.tools ?? [])].sort(),
    discoverySource: report.stages?.discovery?.source ?? null,
    approval: approval ? {
      approved: approval.approved === true,
      challenge: approval.challenge ?? null,
      respondedAt: approval.respondedAt ?? null,
    } : null,
  };
}

const HEX64 = /^[a-f0-9]{64}$/;

/**
 * Validate a received install report — the receiving end's door.
 * The shape is checked field by field; the entry id must be the one
 * derived from the server name (a report naming its own id could
 * squat another server's row); a report asserting a state (above
 * all 'verified') is refused, because verified is a probe's
 * receipt, never a report field — the tool-connections store's
 * honesty rule, applied at this door too. Returns the normalized
 * report.
 */
export function validateInstallLibraryReport(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw badRequest('installReport must be the install report object the pipeline produced');
  }
  for (const key of CREDENTIAL_VALUE_KEYS) {
    if (key in doc) throw badRequest(`installReport carries "${key}" — a credential value never rides this road`);
  }
  if ('state' in doc || 'verified' in doc) {
    throw badRequest('installReport may not assert a state — the receiving end records intent only; verified is a probe receipt, never a report field');
  }
  if (doc.format !== MCP_INSTALL_REPORT_FORMAT || doc.version !== MCP_INSTALL_REPORT_VERSION) {
    throw badRequest(`installReport must be format "${MCP_INSTALL_REPORT_FORMAT}" version ${MCP_INSTALL_REPORT_VERSION}`);
  }
  if (doc.kind !== MCP_LOCAL_KIND) throw badRequest(`installReport kind must be "${MCP_LOCAL_KIND}"`);
  if (doc.brokerMode !== MCP_LOCAL_BROKER_MODE) throw badRequest(`installReport brokerMode must be "${MCP_LOCAL_BROKER_MODE}"`);
  const serverName = typeof doc.serverName === 'string' ? doc.serverName.trim() : '';
  if (!serverName || serverName.length > 256) throw badRequest('installReport serverName is required');
  if (doc.entryId !== mcpLocalEntryId(serverName)) {
    throw badRequest('installReport entryId is not the id derived from its serverName — the id is derived, never named by the report');
  }
  const installedPath = typeof doc.installedPath === 'string' ? doc.installedPath.trim() : '';
  if (!installedPath || installedPath.length > 1024) throw badRequest('installReport installedPath is required');
  if (!(/^\//.test(installedPath) || /^[A-Za-z]:[\\/]/.test(installedPath))) {
    throw badRequest('installReport installedPath must be an absolute path on the machine that ran the pipeline — a relative path names nothing the record can point at');
  }
  const snippet = doc.configSnippet;
  if (!snippet || typeof snippet !== 'object' || Array.isArray(snippet)
    || !snippet.mcpServers || typeof snippet.mcpServers !== 'object' || Array.isArray(snippet.mcpServers)) {
    throw badRequest('installReport configSnippet must be the snippet object the pipeline printed ({ mcpServers: { … } })');
  }
  const serverSnippet = snippet.mcpServers[serverName];
  if (!serverSnippet || typeof serverSnippet !== 'object'
    || typeof serverSnippet.command !== 'string' || !serverSnippet.command
    || !Array.isArray(serverSnippet.args) || serverSnippet.args.some((a) => typeof a !== 'string')) {
    throw badRequest('installReport configSnippet must carry this server\'s { command, args } entry — the snippet is a connection fact, not decoration');
  }
  let baseline = null;
  if (doc.baseline !== null && doc.baseline !== undefined) {
    const b = doc.baseline;
    if (typeof b !== 'object' || Array.isArray(b)
      || !HEX64.test(b.fingerprint ?? '') || !HEX64.test(b.filesHash ?? '') || !HEX64.test(b.permissionsHash ?? '')
      || !Number.isInteger(b.fileCount) || b.fileCount < 0
      || !b.permissions || typeof b.permissions !== 'object' || Array.isArray(b.permissions)) {
      throw badRequest('installReport baseline must carry the ledger fingerprint (fingerprint / filesHash / permissionsHash, fileCount, permissions)');
    }
    baseline = {
      fingerprint: b.fingerprint,
      filesHash: b.filesHash,
      permissionsHash: b.permissionsHash,
      fileCount: b.fileCount,
      permissions: b.permissions,
      approvedAt: typeof b.approvedAt === 'string' ? b.approvedAt : null,
    };
  }
  const declaredTools = doc.declaredTools ?? [];
  if (!Array.isArray(declaredTools) || declaredTools.some((t) => typeof t !== 'string')) {
    throw badRequest('installReport declaredTools must be an array of tool names');
  }
  return {
    format: MCP_INSTALL_REPORT_FORMAT,
    version: MCP_INSTALL_REPORT_VERSION,
    kind: MCP_LOCAL_KIND,
    brokerMode: MCP_LOCAL_BROKER_MODE,
    serverName,
    entryId: doc.entryId,
    name: serverName,
    installedPath,
    configSnippet: snippet,
    baseline,
    declaredTools: [...declaredTools].sort(),
    discoverySource: typeof doc.discoverySource === 'string' ? doc.discoverySource : null,
    approval: doc.approval && typeof doc.approval === 'object'
      ? { approved: doc.approval.approved === true, challenge: doc.approval.challenge ?? null, respondedAt: doc.approval.respondedAt ?? null }
      : null,
  };
}
