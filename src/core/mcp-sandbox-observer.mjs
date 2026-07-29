// Stage 3 instrumentation: the in-process observer injected into a candidate
// MCP server via `node --import`.
//
// It captures the original references to every dangerous API, replaces them
// with recording wrappers, and appends one JSON line per attempt to the file
// named by HELMION_SANDBOX_EVENT_LOG.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS: in-process monkey-patching plus a scrubbed environment.
// WHAT THIS IS NOT: containment.
//
// A determined candidate defeats this observer by, among other things:
//   - spawning a Worker or a child process before the patch is reachable;
//   - using a native addon (.node) or WASM, which never touches these JS paths;
//   - re-importing the real builtin through a fresh module registry;
//   - simply not misbehaving while it is being watched.
//
// The process still runs as the invoking user with that user's full filesystem
// permissions. Everything on disk that the user can read, this can read,
// whether or not the environment was scrubbed. See mcp-sandbox.mjs for the
// full, blunt isolation-strength statement that ships with every report.
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');

// Capture originals BEFORE anything is patched, so the observer's own writes
// neither recurse nor appear in the candidate's event log.
//
// These are deliberately the LOWEST-LEVEL primitives available. The obvious
// choice, fs.appendFileSync, does not work here: internally it calls
// fs.writeFileSync, which this observer patches a few dozen lines below. The
// event log lives OUTSIDE the sandbox working directory on purpose (so the
// candidate cannot tamper with the record of what it did), so the patched
// writeFileSync correctly judged it an out-of-sandbox write and blocked it —
// the observer silently blocking its own audit log, and the harness then
// reading an empty file and reporting a hostile candidate as clean.
//
// fs.writeSync / fs.openSync against a held file descriptor are never patched,
// so the log path cannot be intercepted by the guards it is recording.
const openSync = fs.openSync.bind(fs);
const writeSync = fs.writeSync.bind(fs);
const realCwd = process.cwd();

const EVENT_LOG = process.env.HELMION_SANDBOX_EVENT_LOG;
const POLICY = process.env.HELMION_SANDBOX_POLICY === 'observe' ? 'observe' : 'block';
const CANARY = process.env.HELMION_SANDBOX_CANARY_TOKEN ?? null;

// A security log that fails silently is worse than no log: the harness would
// read an empty file and report a hostile candidate as clean. So a logging
// failure is announced on stderr with a marker the harness looks for, and the
// harness treats a missing log as EVIDENCE MISSING, never as "no activity".
function reportLoggingFailure(message) {
  try {
    writeSync(2, `HELMION_SANDBOX_LOG_FAILURE: ${message}\n`);
  } catch {
    // stderr itself is gone; nothing further can be done from in here.
  }
}

// Held open for the life of the process. Opened through the captured original
// so the observer's own guards can never intercept it.
let logFd = null;
if (EVENT_LOG) {
  try {
    logFd = openSync(EVENT_LOG, 'a');
  } catch (error) {
    reportLoggingFailure(`cannot open ${EVENT_LOG}: ${error.message}`);
  }
} else {
  reportLoggingFailure('HELMION_SANDBOX_EVENT_LOG was not set; no events can be recorded');
}

function record(event) {
  if (logFd === null) return;
  try {
    writeSync(logFd, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  } catch (error) {
    reportLoggingFailure(`${error.code ?? 'ERR'} writing ${EVENT_LOG}: ${error.message}`);
  }
}

/** Does this argument carry the canary? Proof the candidate is exfiltrating. */
function carriesCanary(...values) {
  if (!CANARY) return false;
  for (const value of values) {
    try {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (text && text.includes(CANARY)) return true;
    } catch {
      // Unserializable argument; cannot inspect it.
    }
  }
  return false;
}

function blocked(channel, action, detail, extra = {}) {
  record({ channel, action, detail, blocked: POLICY === 'block', ...extra });
  if (POLICY === 'block') {
    const error = new Error(`HELMION_SANDBOX_BLOCKED: ${channel}.${action} -> ${detail}`);
    error.code = 'HELMION_SANDBOX_BLOCKED';
    throw error;
  }
}

// ── Network ─────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
globalThis.fetch = async function observedFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  const leak = carriesCanary(url, init?.body);
  blocked('network', 'fetch', url, {
    method: init?.method ?? 'GET',
    canaryLeak: leak,
    bodyPreview: typeof init?.body === 'string' ? init.body.slice(0, 400) : undefined,
  });
  return realFetch(input, init);
};

for (const moduleName of ['http', 'https']) {
  const mod = require(moduleName);
  for (const method of ['request', 'get']) {
    const original = mod[method];
    if (typeof original !== 'function') continue;
    mod[method] = function observedRequest(...args) {
      const target = typeof args[0] === 'string' ? args[0] : (args[0]?.hostname ?? args[0]?.host ?? '(options object)');
      blocked('network', `${moduleName}.${method}`, String(target), { canaryLeak: carriesCanary(target) });
      return original.apply(this, args);
    };
  }
}

const net = require('net');
for (const method of ['connect', 'createConnection']) {
  const original = net[method];
  if (typeof original !== 'function') continue;
  net[method] = function observedConnect(...args) {
    const target = typeof args[0] === 'object' ? `${args[0]?.host}:${args[0]?.port}` : String(args[0]);
    blocked('network', `net.${method}`, target);
    return original.apply(this, args);
  };
}

// ── Subprocess execution ────────────────────────────────────────────────────

const childProcess = require('child_process');
for (const method of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
  const original = childProcess[method];
  if (typeof original !== 'function') continue;
  childProcess[method] = function observedSpawn(...args) {
    blocked('process', method, String(args[0]).slice(0, 300));
    return original.apply(this, args);
  };
}

// ── Filesystem ──────────────────────────────────────────────────────────────
// Reads are RECORDED but not blocked — a server legitimately reads its own
// files, and blocking reads breaks module loading. Reads of credential-shaped
// paths are recorded with a flag. Writes outside the throwaway CWD are blocked.

const CREDENTIAL_PATH = /\.ssh|id_rsa|id_ed25519|\.aws|\.npmrc|\.env|\.claude\.json|credentials|Login Data|Cookies|\.git-credentials/i;

function isInsideSandbox(target) {
  try {
    const resolved = path.resolve(String(target));
    const rel = path.relative(realCwd, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

const WRITE_METHODS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream',
  'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'rename', 'renameSync',
  'mkdir', 'mkdirSync', 'copyFile', 'copyFileSync', 'chmod', 'chmodSync',
];
for (const method of WRITE_METHODS) {
  const original = fs[method];
  if (typeof original !== 'function') continue;
  fs[method] = function observedWrite(...args) {
    const target = String(args[0]);
    if (!isInsideSandbox(target)) {
      blocked('filesystem', method, target, { outsideSandbox: true });
    } else {
      record({ channel: 'filesystem', action: method, detail: target, blocked: false, outsideSandbox: false });
    }
    return original.apply(this, args);
  };
}

const READ_METHODS = ['readFile', 'readFileSync', 'createReadStream', 'open', 'openSync'];
for (const method of READ_METHODS) {
  const original = fs[method];
  if (typeof original !== 'function') continue;
  fs[method] = function observedRead(...args) {
    const target = String(args[0]);
    if (CREDENTIAL_PATH.test(target)) {
      // Blocked outright: no MCP server has a reason to read the user's keys.
      blocked('filesystem', method, target, { credentialPath: true });
    }
    return original.apply(this, args);
  };
}

// Promise-based fs mirrors the same surface and would otherwise be an open door.
const fsPromises = require('fs/promises');
for (const method of [...WRITE_METHODS, ...READ_METHODS]) {
  const original = fsPromises[method];
  if (typeof original !== 'function') continue;
  fsPromises[method] = async function observedFsPromise(...args) {
    const target = String(args[0]);
    const isWrite = WRITE_METHODS.includes(method);
    if (isWrite && !isInsideSandbox(target)) {
      blocked('filesystem', `promises.${method}`, target, { outsideSandbox: true });
    } else if (!isWrite && CREDENTIAL_PATH.test(target)) {
      blocked('filesystem', `promises.${method}`, target, { credentialPath: true });
    } else {
      record({ channel: 'filesystem', action: `promises.${method}`, detail: target, blocked: false });
    }
    return original.apply(this, args);
  };
}

// ── Environment enumeration ─────────────────────────────────────────────────
// Replacing process.env with a Proxy lets the harness tell a targeted read of
// one named variable apart from a sweep of the whole environment — the
// distinction that separates a configured server from a credential harvester.

const envSnapshot = { ...process.env };
try {
  process.env = new Proxy(envSnapshot, {
    ownKeys(target) {
      record({ channel: 'env', action: 'enumerate', detail: 'ownKeys(process.env)', blocked: false });
      return Reflect.ownKeys(target);
    },
    get(target, prop) {
      if (typeof prop === 'string') {
        record({ channel: 'env', action: 'read', detail: prop, blocked: false });
      }
      return Reflect.get(target, prop);
    },
  });
} catch (error) {
  record({ channel: 'env', action: 'proxy-install-failed', detail: error.message, blocked: false });
}

record({ channel: 'sandbox', action: 'observer-ready', detail: `policy=${POLICY}`, blocked: false });
