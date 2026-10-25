// Shared between the hands MCP server (Hetzner) and the PC spoke (Troy's PC).
// No dependencies, no I/O. Both sides import THIS file so the tool catalog,
// argument validation, the Guard action shape and decision verification can
// never drift between the hub and the PC that actually executes.
//
// Executive Guard contract: executive-guard/ (PR #53). Canonical JSON and the
// decision envelope ({ payload, signature, keyId }, Ed25519 over the payload
// string, aud 'helmian-executive-guard-decision-v1') mirror that server byte
// for byte.

import { createHash, createPublicKey, verify } from 'node:crypto';

export const DECISION_AUDIENCE = 'helmian-executive-guard-decision-v1';
export const ROOT_GRANT_AUDIENCE = 'helmian-executive-guard-root-grant-v1';
export const GUARD_ACTION_SITE = 'hands.helmian';
export const MAX_OUTPUT_BYTES = 64 * 1024;

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite numbers are not allowed');
    if (value === undefined) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export const sha256Hex = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

// ─── Tool catalog ────────────────────────────────────────────────────────────
// mutating: true  => needs scope hands.act AND a human-approved, signed Guard
//                    decision bound to these exact arguments. No Guard, no run.
// needs           => compute-routing capabilities (src/core/compute-routing.mjs)

export const POWERSHELL_COMMANDS = Object.freeze({
  'git-status': { args: { repo: 'path' }, summary: 'git status of a repo' },
  'git-log': { args: { repo: 'path', count: 'int' }, summary: 'recent git commits of a repo' },
  'disk-free': { args: {}, summary: 'free disk space per drive' },
  'list-processes': { args: {}, summary: 'top 20 processes by CPU' },
  'ollama-list': { args: {}, summary: 'installed Ollama models' },
  'restart-bridge': { args: {}, summary: 'restart the Helmian Bridge service (its in-process spoke re-reads its config)' },
});

export const TOOLS = Object.freeze({
  list_files: { mutating: false, needs: ['local-files'], description: 'List files under a folder inside the PC workspace roots.' },
  read_file: { mutating: false, needs: ['local-files'], description: 'Read a text file inside the PC workspace roots (secrets paths refused, 64 KB cap).' },
  search_files: { mutating: false, needs: ['local-files'], description: 'Search inside the PC workspace roots: match file names by glob and/or file text by a plain-text query (secrets paths refused, results capped).' },
  ollama_generate: { mutating: false, needs: ['ollama'], description: 'Ask a local Ollama model on the PC. Free local compute; nothing leaves the PC except the answer.' },
  run_powershell: { mutating: true, needs: ['powershell'], description: 'Run ONE allow-listed command by id (never free text). Needs a human Guard approval.' },
  open_url: { mutating: true, needs: ['pc-browser'], description: 'Open an https URL in the PC browser. Needs a human Guard approval.' },
  write_file: { mutating: true, needs: ['local-files'], description: 'Write a text file inside the PC workspace roots. Needs a human Guard approval.' },
  move_file: { mutating: true, needs: ['local-files'], description: 'Move or rename a file or folder inside the PC workspace roots. Refuses if the destination already exists. Needs a human Guard approval.' },
  copy_file: { mutating: true, needs: ['local-files'], description: 'Copy a file or folder inside the PC workspace roots. Refuses if the destination already exists. Needs a human Guard approval.' },
  delete_file: { mutating: true, needs: ['local-files'], description: 'Delete a file inside the PC workspace roots; a folder needs recursive: true. Needs a human Guard approval.' },
  make_dir: { mutating: true, needs: ['local-files'], description: 'Create one folder inside the PC workspace roots (its parent folder must already exist). Needs a human Guard approval.' },
  edit_file: { mutating: true, needs: ['local-files'], description: 'Replace exact text in a text file inside the PC workspace roots. Needs a human Guard approval.' },
});

export class ArgError extends Error {}

function str(v, name, max) {
  if (typeof v !== 'string' || !v.trim()) throw new ArgError(`${name} is required`);
  if (v.length > max) throw new ArgError(`${name} is longer than ${max} characters`);
  if (/[\u0000]/.test(v)) throw new ArgError(`${name} contains a NUL byte`);
  return v;
}

/** Normalize and validate arguments. Returns a plain object with only known keys. */
export function validateArgs(tool, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  switch (tool) {
    case 'list_files':
      return { path: str(a.path, 'path', 1024), ...(a.glob ? { glob: str(a.glob, 'glob', 200) } : {}) };
    case 'read_file': {
      const maxBytes = a.maxBytes == null ? MAX_OUTPUT_BYTES : Number(a.maxBytes);
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OUTPUT_BYTES) throw new ArgError(`maxBytes must be 1..${MAX_OUTPUT_BYTES}`);
      return { path: str(a.path, 'path', 1024), maxBytes };
    }
    case 'ollama_generate': {
      const model = str(a.model, 'model', 100);
      if (!/^[A-Za-z0-9._:/-]+$/.test(model)) throw new ArgError('model name has unexpected characters');
      return { model, prompt: str(a.prompt, 'prompt', 20000) };
    }
    case 'run_powershell': {
      const id = str(a.commandId, 'commandId', 64);
      const spec = POWERSHELL_COMMANDS[id];
      if (!spec) throw new ArgError(`commandId must be one of: ${Object.keys(POWERSHELL_COMMANDS).join(', ')}`);
      const inArgs = a.args && typeof a.args === 'object' ? a.args : {};
      const out = {};
      for (const [k, kind] of Object.entries(spec.args)) {
        if (kind === 'path') out[k] = str(inArgs[k], `args.${k}`, 1024);
        if (kind === 'int') {
          const n = inArgs[k] == null ? 10 : Number(inArgs[k]);
          if (!Number.isInteger(n) || n < 1 || n > 50) throw new ArgError(`args.${k} must be 1..50`);
          out[k] = n;
        }
      }
      for (const k of Object.keys(inArgs)) if (!(k in spec.args)) throw new ArgError(`unexpected argument args.${k}`);
      return { commandId: id, args: out };
    }
    case 'open_url': {
      const raw = str(a.url, 'url', 2048);
      let u;
      try { u = new URL(raw); } catch { throw new ArgError('url is not a valid URL'); }
      if (u.protocol !== 'https:') throw new ArgError('only https URLs can be opened');
      return { url: u.toString() };
    }
    case 'write_file': {
      if (typeof a.content !== 'string') throw new ArgError('content is required');
      if (Buffer.byteLength(a.content, 'utf8') > MAX_OUTPUT_BYTES) throw new ArgError('content is larger than 64 KB');
      return { path: str(a.path, 'path', 1024), content: a.content };
    }
    case 'search_files': {
      const out = { path: str(a.path, 'path', 1024) };
      if (a.query) out.query = str(a.query, 'query', 1000);
      if (a.glob) out.glob = str(a.glob, 'glob', 200);
      if (!out.query && !out.glob) throw new ArgError('query or glob is required');
      const maxResults = a.maxResults == null ? 50 : Number(a.maxResults);
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) throw new ArgError('maxResults must be 1..200');
      return { ...out, maxResults };
    }
    case 'move_file':
    case 'copy_file':
      return { path: str(a.path, 'path', 1024), destination: str(a.destination, 'destination', 1024) };
    case 'delete_file': {
      if (a.recursive != null && typeof a.recursive !== 'boolean') throw new ArgError('recursive must be a boolean');
      return { path: str(a.path, 'path', 1024), ...(a.recursive ? { recursive: true } : {}) };
    }
    case 'make_dir':
      return { path: str(a.path, 'path', 1024) };
    case 'edit_file': {
      const find = str(a.find, 'find', 20000);
      if (typeof a.replace !== 'string') throw new ArgError('replace is required');
      if (a.replace.length > 20000) throw new ArgError('replace is longer than 20000 characters');
      if (/[\u0000]/.test(a.replace)) throw new ArgError('replace contains a NUL byte');
      if (a.all != null && typeof a.all !== 'boolean') throw new ArgError('all must be a boolean');
      return { path: str(a.path, 'path', 1024), find, replace: a.replace, ...(a.all ? { all: true } : {}) };
    }
    default:
      throw new ArgError(`unknown tool ${tool}`);
  }
}

// ─── Executive Guard action + decision ───────────────────────────────────────

/** The action sent to Guard for a mutating tool. contentHash binds the exact arguments. */
export function buildGuardAction(tool, args) {
  const summary = tool === 'run_powershell' ? `hands ${tool} ${args.commandId}`
    : tool === 'open_url' ? `hands ${tool} ${new URL(args.url).host}`
    : `hands ${tool}`;
  return {
    kind: 'agent.tool',
    site: GUARD_ACTION_SITE,
    contentHash: sha256Hex(canonicalJson({ tool, args })),
    // 'destructive-intent' routes every mutating hands call to Guard's
    // human-approval rule; without it Guard's default is deny.
    riskSignals: ['destructive-intent', 'hands.act', `tool:${tool}`].sort(),
    summary,
  };
}

export function guardActionHash(action) {
  const { kind, site, contentHash, riskSignals, target } = action;
  return sha256Hex(canonicalJson({ kind, site, contentHash, riskSignals, target }));
}

export function publicKeyFromX(x) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
}

/**
 * Verify that `envelope` is a Guard decision that APPROVES running `tool(args)`:
 * good Ed25519 signature from the pinned key, right audience, not expired,
 * verdict allow, a human approval (approvalId + decidedBy), bound to the same
 * action hash, nonce and device. Anything else is a refusal.
 */
export function verifyApproval({ publicKeyX, envelope, tool, args, nonce, deviceId, now = Date.now() }) {
  try {
    if (!publicKeyX) return { ok: false, error: 'no pinned Guard key' };
    if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') return { ok: false, error: 'malformed decision' };
    const good = verify(null, Buffer.from(envelope.payload, 'utf8'), publicKeyFromX(publicKeyX), Buffer.from(envelope.signature, 'base64url'));
    if (!good) return { ok: false, error: 'bad signature' };
    const claims = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
    if (claims.aud !== DECISION_AUDIENCE) return { ok: false, error: 'wrong audience' };
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) return { ok: false, error: 'expired' };
    if (claims.verdict !== 'allow') return { ok: false, error: `verdict ${claims.verdict}` };
    if (!claims.approvalId || !claims.decidedBy) return { ok: false, error: 'not a human approval' };
    if (claims.actionHash !== guardActionHash(buildGuardAction(tool, args))) return { ok: false, error: 'approval is for different arguments' };
    if (nonce && claims.nonce !== nonce) return { ok: false, error: 'nonce mismatch' };
    if (deviceId && claims.deviceId !== deviceId) return { ok: false, error: 'device mismatch' };
    return { ok: true, claims };
  } catch (error) {
    return { ok: false, error: `unverifiable: ${error.message}` };
  }
}

// ─── PC workspace root grants ────────────────────────────────────────────────
//
// A root grant is NOT a Guard action decision. Existing decisions are bound to
// one tool call, carry a nonce, are single-use, and are intentionally short
// lived; none of those properties can describe standing folder access. A root
// grant therefore uses the same transport-level trust shape as a decision —
// a canonical-JSON payload in an Ed25519 envelope ({ payload, signature,
// keyId }) verified against the Guard key pinned on the PC — but with its own
// audience and claims. It is read-only, bound to one spoke device, and lasts
// until its optional `exp` or until the entry is removed from the local grants
// file (revocation). This distinction matters: today's Executive Guard decision
// endpoint cannot issue one of these long-lived grant envelopes.

export function isAbsoluteRootPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1024
    && !/[\u0000]/.test(value)
    && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
}

/** The Guard action a future hub root-request flow should ask a human to approve. */
export function buildRootGrantAction({ rootPath, scope = 'read-only', spokeDeviceId, expiresAt = null } = {}) {
  if (!isAbsoluteRootPath(rootPath)) throw new TypeError('rootPath must be an absolute path');
  if (scope !== 'read-only') throw new TypeError('root grants are read-only');
  if (!spokeDeviceId || typeof spokeDeviceId !== 'string') throw new TypeError('spokeDeviceId is required');
  return {
    kind: 'agent.tool',
    site: GUARD_ACTION_SITE,
    contentHash: sha256Hex(canonicalJson({ grant: { rootPath, scope, spokeDeviceId, expiresAt } })),
    riskSignals: ['destructive-intent', 'hands.act', 'root-grant'].sort(),
    summary: `hands grant read-only root ${rootPath}`,
  };
}

export function rootGrantActionHash(request) {
  return guardActionHash(buildRootGrantAction(request));
}

/**
 * Verify a signed root-grant envelope against the PC's pinned Guard key.
 * Required claims: aud, grantType='root', grantId, verdict='allow', a human
 * approvalId + decidedBy, rootPath, scope='read-only', spokeDeviceId.
 * Optional claims: requestId, actionHash, iat, exp (epoch seconds). No exp
 * means "until revoked" — the local grants file is the revocation list.
 */
export function verifyRootGrant({ publicKeyX, envelope, spokeDeviceId, now = Date.now() } = {}) {
  try {
    if (!publicKeyX) return { ok: false, error: 'no pinned Guard key' };
    if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') return { ok: false, error: 'malformed root grant' };
    const good = verify(null, Buffer.from(envelope.payload, 'utf8'), publicKeyFromX(publicKeyX), Buffer.from(envelope.signature, 'base64url'));
    if (!good) return { ok: false, error: 'bad signature' };
    const claims = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
    if (claims.aud !== ROOT_GRANT_AUDIENCE) return { ok: false, error: 'wrong audience' };
    if (claims.grantType !== 'root') return { ok: false, error: 'not a root grant' };
    if (!claims.grantId || typeof claims.grantId !== 'string') return { ok: false, error: 'missing grantId' };
    if (claims.verdict !== 'allow') return { ok: false, error: `verdict ${claims.verdict}` };
    if (!claims.approvalId || !claims.decidedBy) return { ok: false, error: 'not a human approval' };
    if (!isAbsoluteRootPath(claims.rootPath)) return { ok: false, error: 'rootPath is not absolute' };
    if (claims.scope !== 'read-only') return { ok: false, error: 'root grants are read-only' };
    if (!claims.spokeDeviceId || typeof claims.spokeDeviceId !== 'string') return { ok: false, error: 'missing spokeDeviceId' };
    if (spokeDeviceId && claims.spokeDeviceId !== spokeDeviceId) return { ok: false, error: 'device mismatch' };
    if (claims.exp != null) {
      if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return { ok: false, error: 'invalid expiry' };
      if (claims.exp * 1000 <= now) return { ok: false, error: 'expired' };
    }
    if (claims.iat != null && (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat))) return { ok: false, error: 'invalid issued-at' };
    return { ok: true, claims };
  } catch (error) {
    return { ok: false, error: `unverifiable: ${error.message}` };
  }
}

// ─── Spoke scope summary (scope-permission spec, bite 1: reporting) ──────────
//
// The spoke reports its file scope to the hub with its poll presence: which
// tier it is in, its built-in default roots, and the folders opened by signed
// root grants. The hub audits the report and flags changes (visibility only —
// a report never grants anything; enforcement stays on the PC, per operation).
// The tier words are the spec's three choices, machine-spelled:
//   full-pc         "Full PC" — agents can look anywhere on this computer
//   pick-folders    "Pick folders" — only the folders listed
//   no-file-access  "No file access" — every file tool refuses
export const SCOPE_TIERS = Object.freeze(['full-pc', 'pick-folders', 'no-file-access']);
export const MAX_SCOPE_PATHS = 32; // per list (roots / grants)
export const MAX_SCOPE_PATH_CHARS = 320;

/**
 * Canonicalize a scope summary arriving over the wire, or return null when it
 * is absent or malformed in any part (a malformed report is treated as no
 * report — never partially trusted). Canonical form: tier validated, roots
 * and grants deduplicated and sorted, so two summaries compare by value.
 */
export function cleanScopeSummary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!SCOPE_TIERS.includes(raw.tier)) return null;
  const cleanList = (v) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > MAX_SCOPE_PATHS) return null;
    const out = new Set();
    for (const entry of v) {
      if (typeof entry !== 'string' || !entry.length || entry.length > MAX_SCOPE_PATH_CHARS) return null;
      out.add(entry);
    }
    return [...out].sort();
  };
  const roots = cleanList(raw.roots);
  const grants = cleanList(raw.grants);
  if (roots === null || grants === null) return null;
  return { tier: raw.tier, roots, grants };
}

/** Both inputs must already be canonical (cleanScopeSummary output). */
export function scopeSummariesEqual(a, b) {
  if (!a || !b) return a === b;
  return a.tier === b.tier
    && a.roots.length === b.roots.length && a.roots.every((r, i) => r === b.roots[i])
    && a.grants.length === b.grants.length && a.grants.every((r, i) => r === b.grants[i]);
}
