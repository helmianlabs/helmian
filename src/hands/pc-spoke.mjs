// Helmian hands: the PC spoke. Runs on Troy's PC inside the HelmianBridge
// service (started by bin/pc-bridge.mjs when hands are configured) or alone:
//   node bin/hands-spoke.mjs pair      (once; asks for the hands passphrase)
//   node bin/hands-spoke.mjs           (run)
//
// OUTBOUND ONLY: it long-polls the hands MCP server on Hetzner; nothing on the
// PC listens on a port.
//
// THE PC DOES NOT TRUST THE HUB ALONE. For every mutating job it re-verifies the
// Executive Guard decision itself, against a Guard public key pinned in the
// LOCAL config (guardPublicKeyX). No pinned key => every mutating job is refused,
// whatever the hub says. Read-only jobs are confined to the configured workspace
// roots and refuse secret-looking paths.

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MAX_OUTPUT_BYTES, TOOLS, validateArgs, verifyApproval } from '../../hands-mcp/src/shared/protocol.mjs';

export const DEFAULT_HANDS_URL = 'https://hands.5-78-222-178.sslip.io';

export function defaultConfigPath() {
  const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(base, 'Helmian', 'hands-spoke.json');
}

export async function readSpokeConfig(path = defaultConfigPath()) {
  try {
    const cfg = JSON.parse(await readFile(path, 'utf8'));
    if (!cfg?.url || !cfg?.token) return null;
    return cfg;
  } catch {
    return null;
  }
}

// ─── Path policy ─────────────────────────────────────────────────────────────

const SECRET_PATH = [
  /(^|[\\/])\.env(\.[^\\/]*)?$/i, /\.(pem|key|pfx|p12|kdbx|ppk)$/i, /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i, /(^|[\\/])\.aws([\\/]|$)/i, /(^|[\\/])\.git[\\/]config$/i, /(^|[\\/])\.npmrc$/i,
  /AppData[\\/]Roaming[\\/]Helmian([\\/]|$)/i, /(^|[\\/])Helmion[\\/]Herald([\\/]|$)/i, /secret/i, /credential/i,
  /(^|[\\/])hands-spoke\.json$/i, /pc-bridge-token\.json$/i, /vault/i,
];

export function isSecretPath(p) {
  return SECRET_PATH.some((re) => re.test(p));
}

function within(root, target, caseInsensitive) {
  const r = caseInsensitive ? root.toLowerCase() : root;
  const t = caseInsensitive ? target.toLowerCase() : target;
  const rel = relative(r, t);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Resolve `p` (following symlinks for what exists) and require it inside a root. */
export async function confinePath(p, roots, { mustExist = true, caseInsensitive = platform() === 'win32' } = {}) {
  if (!Array.isArray(roots) || !roots.length) throw new Error('No workspace roots are configured on the PC.');
  const abs = resolve(p);
  let real;
  try { real = await realpath(abs); }
  catch (e) {
    if (mustExist) throw new Error(`Not found: ${p}`);
    real = join(await realpath(dirname(abs)).catch(() => { throw new Error(`Folder not found: ${dirname(abs)}`); }), abs.split(sep).pop());
  }
  const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => resolve(r))));
  if (!realRoots.some((root) => within(root, real, caseInsensitive))) throw new Error(`Outside the workspace roots: ${p}`);
  if (isSecretPath(real)) throw new Error(`Refused: ${p} looks like a secrets path.`);
  return real;
}

// ─── Execution ───────────────────────────────────────────────────────────────

function cap(text) {
  const s = String(text ?? '');
  const buf = Buffer.from(s, 'utf8');
  return buf.length <= MAX_OUTPUT_BYTES ? s : `${buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf8')}\n…[truncated at 64 KB]`;
}

function run(file, args, { timeoutMs = 30000, spawnImpl = spawn } = {}) {
  return new Promise((resolveRun) => {
    let out = '';
    let err = '';
    let child;
    try { child = spawnImpl(file, args, { shell: false, windowsHide: true }); }
    catch (e) { resolveRun({ ok: false, error: e.message }); return; }
    const t = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout?.on('data', (d) => { if (out.length < MAX_OUTPUT_BYTES * 2) out += d; });
    child.stderr?.on('data', (d) => { if (err.length < 8192) err += d; });
    child.on('error', (e) => { clearTimeout(t); resolveRun({ ok: false, error: e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolveRun(code === 0 ? { ok: true, output: cap(out) } : { ok: false, error: `exit ${code}: ${cap(err || out).slice(0, 2000)}` }); });
  });
}

const PS = ['-NoProfile', '-NonInteractive', '-Command'];
const PS_SCRIPTS = {
  'disk-free': "Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}},@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}} | Format-Table -AutoSize | Out-String -Width 200",
  'list-processes': 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Name,Id,@{n="CPU";e={[math]::Round($_.CPU,1)}},@{n="MemMB";e={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize | Out-String -Width 200',
};

function globToRegex(glob) {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

export function createExecutor({ roots, guardPublicKeyX = null, guardDeviceId = 'hands-mcp', spawnImpl = spawn, fetchImpl = fetch, now = Date.now } = {}) {
  const usedDecisions = new Map(); // decisionId -> exp ms (single use)

  async function execute(job) {
    const spec = TOOLS[job?.tool];
    if (!spec) return { ok: false, error: `unknown tool ${job?.tool}` };
    let args;
    try { args = validateArgs(job.tool, job.args); } catch (e) { return { ok: false, error: `bad arguments: ${e.message}` }; }

    if (spec.mutating) {
      const v = verifyApproval({ publicKeyX: guardPublicKeyX, envelope: job.guardDecision, tool: job.tool, args, nonce: job.nonce, deviceId: guardDeviceId, now: now() });
      if (!v.ok) return { ok: false, error: `refused by the PC: ${v.error === 'no pinned Guard key' ? 'no Executive Guard key is pinned on this PC, so mutating actions are refused' : `Guard decision did not verify (${v.error})`}` };
      for (const [id, exp] of usedDecisions) if (exp < now()) usedDecisions.delete(id);
      if (usedDecisions.has(v.claims.decisionId)) return { ok: false, error: 'refused by the PC: that Guard approval was already used' };
      usedDecisions.set(v.claims.decisionId, v.claims.exp * 1000);
    }

    try {
      switch (job.tool) {
        case 'list_files': {
          const dir = await confinePath(args.path, roots);
          const re = args.glob ? globToRegex(args.glob) : null;
          const entries = (await readdir(dir, { withFileTypes: true }))
            .filter((e) => !re || re.test(e.name))
            .filter((e) => !isSecretPath(join(dir, e.name)))
            .slice(0, 500)
            .map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`);
          return { ok: true, output: cap(`${dir}\n${entries.join('\n') || '(empty)'}`) };
        }
        case 'read_file': {
          const file = await confinePath(args.path, roots);
          const st = await stat(file);
          if (!st.isFile()) return { ok: false, error: 'not a file' };
          const buf = (await readFile(file)).subarray(0, args.maxBytes);
          if (buf.includes(0)) return { ok: false, error: 'binary file; refused' };
          return { ok: true, output: cap(buf.toString('utf8') + (st.size > args.maxBytes ? `\n…[${st.size - args.maxBytes} more bytes]` : '')) };
        }
        case 'ollama_generate': {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 120000);
          try {
            const res = await fetchImpl('http://127.0.0.1:11434/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: args.model, prompt: args.prompt, stream: false }), signal: ctrl.signal });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) return { ok: false, error: `ollama ${res.status}: ${body.error || ''}` };
            return { ok: true, output: cap(body.response || '') };
          } finally { clearTimeout(t); }
        }
        case 'run_powershell': {
          const { commandId, args: a } = args;
          if (commandId === 'git-status') return run('git', ['-C', await confinePath(a.repo, roots), 'status', '--short', '--branch'], { spawnImpl });
          if (commandId === 'git-log') return run('git', ['-C', await confinePath(a.repo, roots), 'log', '--oneline', '-n', String(a.count)], { spawnImpl });
          if (commandId === 'ollama-list') return run('ollama', ['list'], { spawnImpl });
          if (PS_SCRIPTS[commandId]) return run('powershell.exe', [...PS, PS_SCRIPTS[commandId]], { spawnImpl });
          return { ok: false, error: 'command not on the PC allow-list' };
        }
        case 'open_url': {
          if (platform() !== 'win32') return { ok: false, error: 'open_url is only wired for Windows' };
          return run('explorer.exe', [args.url], { spawnImpl }).then((r) => (r.ok || /exit 1/.test(r.error || '') ? { ok: true, output: `Opened ${args.url}` } : r));
        }
        case 'write_file': {
          const file = await confinePath(args.path, roots, { mustExist: false });
          await writeFile(file, args.content, 'utf8');
          return { ok: true, output: `Wrote ${Buffer.byteLength(args.content, 'utf8')} bytes to ${file}` };
        }
        default:
          return { ok: false, error: 'not implemented' };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { execute };
}

async function detectCapabilities(fetchImpl) {
  const caps = ['local-files'];
  if (platform() === 'win32') caps.push('powershell', 'pc-browser');
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetchImpl('http://127.0.0.1:11434/api/tags', { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) caps.push('ollama');
  } catch {}
  return caps;
}

/** Long-poll loop. Returns { stop }. */
export function startSpoke({ config, fetchImpl = fetch, log = (...a) => console.log('[hands-spoke]', ...a), executor } = {}) {
  const roots = config.roots?.length ? config.roots : [process.env.HELMIAN_ROOT || process.cwd()];
  const exec = executor || createExecutor({ roots, guardPublicKeyX: config.guardPublicKeyX || null, guardDeviceId: config.guardDeviceId || 'hands-mcp', fetchImpl });
  let stopped = false;
  let ctrl = null;
  let caps = null;
  let capsAt = 0;
  const deviceId = config.deviceId || `pc-${hostname()}`.toLowerCase().slice(0, 60);
  const post = (path, body, signal) => fetchImpl(`${config.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` }, body: JSON.stringify(body), signal });

  (async () => {
    log(`connected to ${config.url} as ${deviceId}; roots: ${roots.join(', ')}; mutating: ${config.guardPublicKeyX ? 'Guard-verified' : 'refused (no Guard key pinned)'}`);
    let backoff = 1000;
    while (!stopped) {
      try {
        if (!caps || Date.now() - capsAt > 300000) { caps = await detectCapabilities(fetchImpl); capsAt = Date.now(); }
        ctrl = new AbortController();
        const res = await post('/spoke/v1/poll', { deviceId, capabilities: caps }, ctrl.signal);
        if (res.status === 401) { log('the hands server rejected this PC (401). Re-pair with: node bin/hands-spoke.mjs pair'); await new Promise((r) => setTimeout(r, 60000)); continue; }
        if (!res.ok) throw new Error(`poll ${res.status}`);
        const { job } = await res.json();
        backoff = 1000;
        if (!job) continue;
        log(`job ${job.id}: ${job.tool}`);
        const result = await exec.execute(job);
        log(`job ${job.id}: ${result.ok ? 'done' : `refused/failed: ${result.error}`}`);
        await post('/spoke/v1/result', { jobId: job.id, ...result });
      } catch (e) {
        if (stopped) break;
        log(`connection problem (${e.message}); retrying in ${backoff / 1000}s`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  })();

  return { stop() { stopped = true; try { ctrl?.abort(); } catch {} } };
}

/** Exchange the hands passphrase for a spoke token and save the local config. */
export async function pairSpoke({ url = DEFAULT_HANDS_URL, passphrase, roots, configPath = defaultConfigPath(), fetchImpl = fetch, deviceId = `pc-${hostname()}`.toLowerCase().slice(0, 60) }) {
  const res = await fetchImpl(`${url}/spoke/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase, deviceId }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(body.error || `pairing failed (${res.status})`);
  const existing = (await readSpokeConfig(configPath)) || {};
  const cfg = { ...existing, url, token: body.token, deviceId, roots: roots?.length ? roots : existing.roots || [], pairedAt: new Date().toISOString() };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return { configPath, deviceId, roots: cfg.roots };
}
