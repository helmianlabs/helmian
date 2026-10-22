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
});

export const TOOLS = Object.freeze({
  list_files: { mutating: false, needs: ['local-files'], description: 'List files under a folder inside the PC workspace roots.' },
  read_file: { mutating: false, needs: ['local-files'], description: 'Read a text file inside the PC workspace roots (secrets paths refused, 64 KB cap).' },
  ollama_generate: { mutating: false, needs: ['ollama'], description: 'Ask a local Ollama model on the PC. Free local compute; nothing leaves the PC except the answer.' },
  run_powershell: { mutating: true, needs: ['powershell'], description: 'Run ONE allow-listed command by id (never free text). Needs a human Guard approval.' },
  open_url: { mutating: true, needs: ['pc-browser'], description: 'Open an https URL in the PC browser. Needs a human Guard approval.' },
  write_file: { mutating: true, needs: ['local-files'], description: 'Write a text file inside the PC workspace roots. Needs a human Guard approval.' },
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
