import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAndStartTask, schtasksCreateArgs, taskScript, verifySpoke, readHeartbeat } from '../spoke-installer/install-pair.mjs';
import { startSpoke } from '../src/hands/pc-spoke.mjs';

const env = { SystemRoot: 'C:\\Windows', USERDOMAIN: 'PC', USERNAME: 'troy' };

test('task script runs the spoke hidden, restarts on failure, no time limit, starts now', () => {
  const s = taskScript();
  assert.match(s, /conhost\.exe/);
  assert.match(s, /--headless/);
  assert.match(s, /-AtLogOn -User \$me/);
  assert.match(s, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(s, /-RestartCount 999/);
  assert.match(s, /Start-ScheduledTask -TaskName \$name/);
  assert.doesNotMatch(s, /RunLevel Highest/);
});

test('schtasks fallback keeps the quotes and runs as the signed-in user, hidden', () => {
  const a = schtasksCreateArgs('C:\\Users\\t\\AppData\\Local\\Programs\\HelmianSpoke', env);
  assert.match(a, /\/RU "PC\\troy" \/IT/);
  assert.match(a, /\/TR "C:\\Windows\\System32\\conhost\.exe --headless \\"C:\\Users\\t\\AppData\\Local\\Programs\\HelmianSpoke\\node\.exe\\" \\".*hands-spoke\.mjs\\""$/);
});

test('PowerShell path is used first; its success is reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spk-'));
  const calls = [];
  const spawn = (cmd, args) => { calls.push(cmd); return { status: 0, stdout: 'registered-and-started\n', stderr: '' }; };
  const r = registerAndStartTask({ appDir: dir, spawn, env });
  assert.deepEqual(r, { ok: true, method: 'powershell' });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /powershell\.exe$/);
});

test('PowerShell failure falls back to schtasks, and every error is logged, not silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spk-'));
  const lines = [];
  const spawn = (cmd) => (/powershell/.test(cmd) ? { status: 1, stdout: '', stderr: 'Access is denied.' } : { status: 0, stdout: 'SUCCESS', stderr: '' });
  const r = registerAndStartTask({ appDir: dir, spawn, env, log: (m) => lines.push(m) });
  assert.equal(r.ok, true); assert.equal(r.method, 'schtasks');
  assert.ok(lines.some((l) => l.includes('Access is denied.')));
});

test('both methods failing gives a plain error for the last page', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spk-'));
  const spawn = (cmd) => ({ status: 1, stdout: '', stderr: /powershell/.test(cmd) ? 'PS broke' : 'ERROR: Access is denied.' });
  const r = registerAndStartTask({ appDir: dir, spawn, env });
  assert.equal(r.ok, false);
  assert.match(r.error, /PS broke/); assert.match(r.error, /Access is denied/);
});

test('verifySpoke: running + fresh connected heartbeat = success; stale heartbeat does not count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spk-'));
  const hbf = join(dir, 'hb.json');
  let t = Date.parse('2026-10-30T19:00:00Z');
  writeFileSync(hbf, JSON.stringify({ connected: true, status: 200, at: '2026-10-30T18:00:00Z' }));
  assert.equal(readHeartbeat(hbf, t), null, 'old heartbeat ignored');
  const ok = await verifySpoke({ heartbeatFile: hbf, sinceMs: t, timeoutMs: 10000, isRunning: () => true, now: () => t, sleep: async (ms) => { t += ms; writeFileSync(hbf, JSON.stringify({ connected: true, status: 200, at: new Date(t).toISOString() })); } });
  assert.deepEqual(ok, { running: true, connected: true });
});

test('verifySpoke: not running / 401 give plain reasons', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spk-'));
  const hbf = join(dir, 'hb.json');
  let t = 1_000_000;
  const tick = { now: () => t, sleep: async (ms) => { t += ms; } };
  const dead = await verifySpoke({ heartbeatFile: hbf, sinceMs: t, timeoutMs: 6000, isRunning: () => false, ...tick });
  assert.equal(dead.running, false); assert.match(dead.error, /did not keep running/);
  writeFileSync(hbf, JSON.stringify({ connected: false, status: 401, at: new Date(t).toISOString() }));
  const rej = await verifySpoke({ heartbeatFile: hbf, sinceMs: t, timeoutMs: 6000, isRunning: () => true, ...tick });
  assert.match(rej.error, /did not accept this PC/);
});

test('startSpoke calls the heartbeat after each poll answer', async () => {
  const beats = [];
  let n = 0;
  let handle;
  const fetchImpl = async (url) => {
    if (String(url).includes('/spoke/v1/poll')) { n += 1; if (n >= 2) handle.stop(); return { ok: true, status: 200, json: async () => ({ job: null }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  handle = startSpoke({ config: { url: 'https://hands.test', token: 't', deviceId: 'pc-x', roots: [tmpdir()] }, fetchImpl, log: () => {}, executor: { execute: async () => ({ ok: true }) }, scopeProvider: async () => null, heartbeat: (b) => beats.push(b) });
  for (let i = 0; i < 50 && beats.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
  handle.stop();
  assert.ok(beats.length >= 1);
  assert.deepEqual(beats[0], { connected: true, status: 200 });
});
