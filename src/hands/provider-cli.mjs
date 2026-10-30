// Subscription sign-in on the user's own PC, through each provider's OFFICIAL,
// unmodified CLI. Helmian never collects, stores, copies, or relays the
// provider credential: the CLI runs its own sign-in in a visible window and
// keeps its own token file. We only check whether that file exists.
//
// Why this shape (sources in docs/NEW_USER_SETUP.md):
// - Claude: Anthropic allows an end user to sign in to the unmodified Claude
//   Code binary with their own plan; it forbids third parties offering Claude
//   login or collecting/relaying Claude tokens (so no "paste your token" step).
// - ChatGPT: Codex CLI "Sign in with ChatGPT" is OpenAI's own flow.
// - Gemini: Gemini CLI "Login with Google" is Google's own flow; Google forbids
//   other software piggybacking on that OAuth, so Helmian only launches the CLI.
// - Grok: the official Grok CLI (`grok login`, `--device-auth`) is xAI's flow.
// - Antigravity: an IDE with no supported third-party access; status only.
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';

export const PAIR_CODE_RE = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/i;
export function looksLikePairCode(s) { return PAIR_CODE_RE.test(String(s || '').trim()); }

export const PROVIDER_CLIS = Object.freeze([
  { id: 'claude', label: 'Claude (Claude Code)', bin: 'claude', install: 'npm install -g @anthropic-ai/claude-code', login: ['claude'], files: ['.claude/.credentials.json', '.claude.json'], note: 'type /login if it does not ask' },
  { id: 'chatgpt', label: 'ChatGPT (Codex CLI)', bin: 'codex', install: 'npm install -g @openai/codex', login: ['codex', 'login'], files: ['.codex/auth.json'] },
  { id: 'gemini', label: 'Gemini (Gemini CLI)', bin: 'gemini', install: 'npm install -g @google/gemini-cli', login: ['gemini'], files: ['.gemini/oauth_creds.json'], note: 'pick "Login with Google"' },
  { id: 'grok', label: 'SuperGrok (Grok CLI)', bin: 'grok', install: 'see https://x.ai/cli for the official installer', login: ['grok', 'login'], files: ['.grok/auth.json'] },
]);

async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function onPath(bin, env = process.env) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = platform() === 'win32' ? ['.cmd', '.exe', '.ps1', ''] : [''];
  for (const d of dirs) for (const e of exts) if (await exists(path.join(d, bin + e))) return true;
  return false;
}

export async function providerStatus({ home = homedir(), env = process.env } = {}) {
  const rows = [];
  for (const p of PROVIDER_CLIS) {
    const installed = await onPath(p.bin, env);
    let signedIn = false;
    for (const f of p.files) if (await exists(path.join(home, f))) { signedIn = true; break; }
    rows.push({ id: p.id, label: p.label, installed, signedIn: installed && signedIn, install: p.install });
  }
  rows.push({ id: 'antigravity', label: 'Google Antigravity', installed: false, signedIn: false, note: 'no supported third-party access; use the Antigravity app itself' });
  return rows;
}

export function loginCommand(id, plat = platform()) {
  const p = PROVIDER_CLIS.find((x) => x.id === String(id || '').toLowerCase() || (id === 'openai' && x.id === 'chatgpt') || (id === 'xai' && x.id === 'grok'));
  if (!p) return null;
  const cmd = p.login.join(' ');
  if (plat === 'win32') return { p, file: 'cmd.exe', args: ['/c', 'start', `"Sign in: ${p.label}"`, 'cmd.exe', '/k', cmd] };
  if (plat === 'darwin') return { p, file: 'osascript', args: ['-e', `tell application "Terminal" to do script "${cmd}"`] };
  return { p, file: 'x-terminal-emulator', args: ['-e', cmd] };
}

export async function openProviderLogin(id, { spawnImpl = spawn } = {}) {
  const lc = loginCommand(id);
  if (!lc) return { ok: false, message: `Unknown provider "${id}". Use one of: ${PROVIDER_CLIS.map((x) => x.id).join(', ')}.` };
  if (!(await onPath(lc.p.bin))) return { ok: false, message: `${lc.p.label} is not installed. Install it first: ${lc.p.install}` };
  const child = spawnImpl(lc.file, lc.args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
  child.unref?.();
  return { ok: true, message: `Opened ${lc.p.label} sign-in in a new window${lc.p.note ? ` (${lc.p.note})` : ''}. Finish it there; Helmian never sees your password or token.` };
}
