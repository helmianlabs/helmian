#!/usr/bin/env node
// Helmian Spoke installer helper — run by the Setup program, hidden. Also run
// by the "Try again" button on Setup's last page (with no code: keeps pairing).
//   1. Pairs this PC (the passphrase/code arrives in the environment, set by
//      the installer from its own pairing page; it is never stored).
//   2. Pins the Executive Guard public key (fetched live; a known public key
//      is kept as a fallback — public keys are not secrets).
//   3. Registers the HelmianSpoke sign-in task so the spoke runs HIDDEN
//      (conhost --headless, no window ever), with restart-on-failure and no
//      3-day time limit. PowerShell Register-ScheduledTask first (works without
//      admin); schtasks.exe as a fallback. Every failure is logged, never silent.
//   4. Starts it now (no restart needed) and checks it is really running and
//      has reached the hub (the spoke writes spoke-heartbeat.json per poll).
//   5. Writes %APPDATA%\Helmian\spoke-install-status.json so the installer's
//      last page can say honestly what worked and offer a one-click retry.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TASK_NAME = 'HelmianSpoke';
const GUARD_KEYS_URL = 'https://guard.5-78-222-178.sslip.io/v1/keys';
const FALLBACK_GUARD_X = 'gl0V8jCzSUtxVPlG6ZXtNXljhfGxDCUdpVZC00h0R4I';

export function helmianDir(env = process.env) {
  return path.join(env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'Helmian');
}

/** PowerShell that (re)registers and starts the hidden spoke task. Takes -Dir. */
export function taskScript() {
  return `param([Parameter(Mandatory=$true)][string]$Dir)
$ErrorActionPreference = 'Stop'
$name = '${TASK_NAME}'
$me = if ($env:USERDOMAIN) { "$env:USERDOMAIN\\$env:USERNAME" } else { $env:USERNAME }
Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*hands-spoke.mjs*' -and $_.CommandLine -notlike '* pair*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$conhost = Join-Path $env:SystemRoot 'System32\\conhost.exe'
$arg = '--headless "' + (Join-Path $Dir 'node.exe') + '" "' + (Join-Path $Dir 'bin\\hands-spoke.mjs') + '"'
$action = New-ScheduledTaskAction -Execute $conhost -Argument $arg -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -DontStopOnIdleEnd -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Helmian Spoke: lets your Helmian AIs reach this PC, with Executive Guard approval. Runs hidden.' -Force | Out-Null
Start-ScheduledTask -TaskName $name
'registered-and-started'
`;
}

/** schtasks.exe fallback command line (verbatim, so the nested quotes survive). */
export function schtasksCreateArgs(appDir, env = process.env) {
  const conhost = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe');
  const tr = `${conhost} --headless \\"${path.win32.join(appDir, 'node.exe')}\\" \\"${path.win32.join(appDir, 'bin', 'hands-spoke.mjs')}\\"`;
  const me = env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
  return `/Create /F /TN ${TASK_NAME} /SC ONLOGON /RL LIMITED${me ? ` /RU "${me}" /IT` : ''} /TR "${tr}"`;
}

const short = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300);

/** Register + start the task. Returns { ok, method, error }. Never throws. */
export function registerAndStartTask({ appDir, spawn = spawnSync, log = () => {}, env = process.env }) {
  const ps = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const scriptPath = path.join(appDir, 'register-spoke-task.ps1');
  let psError = '';
  try {
    writeFileSync(scriptPath, taskScript());
    const r = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath, '-Dir', appDir], { encoding: 'utf8', timeout: 90000, windowsHide: true });
    log(`powershell register: exit ${r.status} ${short(r.stdout)} ${short(r.stderr)} ${r.error ? short(r.error.message) : ''}`);
    if (r.status === 0 && /registered-and-started/.test(r.stdout || '')) return { ok: true, method: 'powershell' };
    psError = short(r.stderr) || (r.error && short(r.error.message)) || `exit ${r.status}`;
  } catch (e) { psError = short(e.message); log(`powershell register threw: ${psError}`); }

  try {
    const c = spawn('schtasks.exe', [schtasksCreateArgs(appDir, env)], { encoding: 'utf8', timeout: 60000, windowsHide: true, windowsVerbatimArguments: true, shell: false });
    log(`schtasks create: exit ${c.status} ${short(c.stdout)} ${short(c.stderr)}`);
    if (c.status === 0) {
      const run = spawn('schtasks.exe', ['/Run', '/TN', TASK_NAME], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      log(`schtasks run: exit ${run.status} ${short(run.stderr)}`);
      return { ok: true, method: 'schtasks', ...(run.status === 0 ? {} : { error: `task made but would not start: ${short(run.stderr)}` }) };
    }
    return { ok: false, method: null, error: `could not set up the background task (PowerShell: ${psError}; schtasks: ${short(c.stderr) || `exit ${c.status}`})` };
  } catch (e) {
    return { ok: false, method: null, error: `could not set up the background task (PowerShell: ${psError}; schtasks: ${short(e.message)})` };
  }
}

/** True if a node.exe running hands-spoke.mjs (not "pair") exists. */
export function spokeProcessRunning({ spawn = spawnSync, env = process.env } = {}) {
  const ps = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd = "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*hands-spoke.mjs*' -and $_.CommandLine -notlike '*install-pair*' }).Count";
  const r = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  return r.status === 0 && Number(String(r.stdout || '').trim()) > 0;
}

/** Read the heartbeat if it was written after `sinceMs`. */
export function readHeartbeat(file, sinceMs) {
  try {
    const hb = JSON.parse(readFileSync(file, 'utf8'));
    if (Date.parse(hb.at) >= sinceMs - 2000) return hb;
  } catch { /* none yet */ }
  return null;
}

/** Wait until the spoke runs and reaches the hub. */
export async function verifySpoke({ heartbeatFile, sinceMs, timeoutMs = 60000, intervalMs = 3000, isRunning = () => spokeProcessRunning(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const end = now() + timeoutMs;
  let running = false;
  let hb = null;
  while (now() < end) {
    running = isRunning();
    hb = readHeartbeat(heartbeatFile, sinceMs);
    if (running && hb && hb.connected) return { running: true, connected: true };
    await sleep(intervalMs);
  }
  if (!running) return { running: false, connected: false, error: 'the spoke did not keep running after it was started' };
  if (hb && hb.status === 401) return { running: true, connected: false, error: 'the Helmian server did not accept this PC; pair it again with a new code' };
  return { running: true, connected: false, error: 'the spoke is running but could not reach the Helmian server (check the internet connection)' };
}

async function main() {
  const appDir = process.cwd();
  const node = path.join(appDir, 'node.exe');
  const spoke = path.join(appDir, 'bin', 'hands-spoke.mjs');
  const roots = process.env.HELMIAN_SPOKE_ROOTS || homedir();
  const dir = helmianDir();
  mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'spoke-install.log');
  const log = (m) => { try { appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ } };
  const status = { paired: false, guardPinned: false, taskRegistered: false, started: false, running: false, connected: false, error: null, log: logPath, at: new Date().toISOString() };
  const save = () => { try { writeFileSync(path.join(dir, 'spoke-install-status.json'), JSON.stringify(status, null, 2) + '\n'); } catch { /* last page falls back */ } };
  const run = (args) => spawnSync(node, [spoke, ...args], { env: process.env, encoding: 'utf8', timeout: 120000, windowsHide: true });
  log(`install-pair start in ${appDir}`);

  const configPath = path.join(dir, 'hands-spoke.json');
  if (!String(process.env.HELMIAN_HANDS_PASSPHRASE || '').trim() && existsSync(configPath)) {
    status.paired = true; // upgrade/retry with the code left blank: keep the existing pairing
    status.keptPairing = true;
  } else {
    try {
      const pair = run(['pair', '--roots', roots]);
      status.paired = pair.status === 0;
      log(`pair: exit ${pair.status}`); // output may echo the device id only; never the code
      if (!status.paired) status.error = 'pairing did not finish (the code may be used or expired)';
    } catch (e) { status.error = 'pairing did not finish'; log(`pair threw: ${short(e.message)}`); }
  }

  if (status.paired) {
    try {
      let x = FALLBACK_GUARD_X;
      try {
        const res = await fetch(GUARD_KEYS_URL, { signal: AbortSignal.timeout(8000) });
        const j = await res.json();
        if (j && j.publicKeyJwk && typeof j.publicKeyJwk.x === 'string') x = j.publicKeyJwk.x;
      } catch { log('guard key fetch failed; using the built-in key'); }
      status.guardPinned = run(['pin-guard', x]).status === 0;
    } catch { /* mutating actions stay refused until pinned — fail closed */ }

    const heartbeatFile = path.join(dir, 'spoke-heartbeat.json');
    try { rmSync(heartbeatFile, { force: true }); } catch { /* ignore */ }
    const sinceMs = Date.now();
    const t = registerAndStartTask({ appDir, log });
    status.taskRegistered = t.ok;
    status.taskMethod = t.method;
    status.started = t.ok && !t.error;
    if (t.error) status.error = t.error;
    if (t.ok) {
      const v = await verifySpoke({ heartbeatFile, sinceMs });
      status.running = v.running;
      status.connected = v.connected;
      if (v.error) status.error = v.error;
      log(`verify: running=${v.running} connected=${v.connected}${v.error ? ` (${v.error})` : ''}`);
    }
  }
  status.at = new Date().toISOString();
  save();
  log(`install-pair done: ${JSON.stringify({ ...status, log: undefined })}`);
  process.exit(status.paired ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
