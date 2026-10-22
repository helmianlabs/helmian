// OPTIONAL: the Flags client against Paul's REAL server code, run locally.
// Skipped unless SMM_SAAS_APP_DIR points at a checkout of
// troy83352/shared-memory-mcp (branch saas) server.src/app with its deps
// installed. Loopback only, in-memory database, no real keys, no production.
//   SMM_SAAS_APP_DIR=/path/to/shared-memory-mcp/server.src/app node --test extension/test/flags-live-saas.test.mjs
import { FAKE } from '../test-support/fake-secrets.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { memoryStorage } from '../test-support/mock-flags-api.mjs';
import { pollAlerts, reportFlag, scanText, setFlagsSettings } from '../background/flags-client.js';

const DIR = process.env.SMM_SAAS_APP_DIR;
const HARNESS = fileURLToPath(new URL('../test-support/flags-saas-harness.mts', import.meta.url));

async function startReal() {
  const env = { ...process.env };
  // No outside calls from the server under test: no moderation, mail or webhooks.
  for (const k of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'ALERT_WEBHOOK_URL', 'ALERT_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY', 'DATABASE_URL']) delete env[k];
  const child = spawn(process.execPath, ['--import', 'tsx', HARNESS], { cwd: DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const info = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`harness did not start: ${err.slice(-500)}`)), 60000);
    child.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`harness exited ${code}: ${err.slice(-500)}`)); });
  });
  assert.match(info.base, /^http:\/\/127\.0\.0\.1:\d+$/);
  return { ...info, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); }) };
}

test('LIVE (local): report, list and scan against shared-memory-mcp saas', { skip: !DIR && 'SMM_SAAS_APP_DIR not set' }, async () => {
  const real = await startReal();
  try {
    const storage = memoryStorage();
    await setFlagsSettings(storage, { enabled: true, baseUrl: real.base, apiKey: real.key, scanBeforeSend: true });
    const now = Date.now();

    const whsec = `whsec_${'D'.repeat(24)}`;
    const report = await reportFlag(storage, {
      id: 'live-1', kind: 'privacy-leak', rule: 'secret:api_key', signals: ['secret:api_key'],
      label: 'The reply shows an API key', site: 'claude.ai', lane: 'prose',
      excerpt: `key sk-proj-abcdefghijklmnop1234 and ${whsec}; then run rm -rf / now`, url: 'https://claude.ai/chat/xyz?q=1',
    }, { version: '0.4.0', browser: 'chrome', now });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.sent, 1);
    // whsec_ is now redacted by Guard before sending, so the real server finds no secret
    // of its own; its scan still adds the harmful-code flag for the command.
    assert.ok(!(report.serverFlags || []).some((f) => f.category === 'secret'), `server found a secret Guard left in: ${JSON.stringify(report.serverFlags)}`);
    assert.ok((report.serverFlags || []).some((f) => f.rule === 'harmful.rm_rf_root'), 'server scan did not add its own flag');

    const hedge = await reportFlag(storage, { id: 'live-2', kind: 'evasion', rule: 'hedging', label: 'The answer is buried in hedges', site: 'grok.com' }, { version: '0.4.0', now });
    assert.equal(hedge.sent, 1);

    const alerts = await pollAlerts(storage, { force: true, now });
    assert.equal(alerts.ok, true, JSON.stringify(alerts));
    const ours = alerts.alerts.find((a) => a.origin === 'api' && a.source_ai === 'claude.ai');
    assert.ok(ours, 'reported flag not listed');
    assert.equal(ours.severity, 'high');
    assert.equal(ours.category, 'secret');
    assert.doesNotMatch(JSON.stringify(alerts), /abcdefghijklmnop1234|DDDDDDDDDDDDDDDDDDDDDDDD/);
    assert.ok(!alerts.alerts.some((a) => a.category === 'hedging'), 'min_severity=high let a low flag through');

    // Every pattern added in 0.4.1 is redacted locally, so the real scanner sees no leak.
    const gaps = [whsec, FAKE.resend, FAKE.stripeTest, FAKE.awsTemp,
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'postgres://app:Sup3rS3cret@db.internal:5432/main', 'my password is hunter2!', FAKE.slackRefresh,
      `aws_secret_access_key=${FAKE.awsSecret}`, 'SSN 123 45 6789'];
    const scan = await scanText(storage, `deploy with ${gaps.join(' and ')} now`, { now });
    assert.equal(scan.ok, true, JSON.stringify(scan));
    assert.deepEqual(scan.leaks, [], `the real scanner found what Guard missed: ${JSON.stringify(scan.leaks)}`);
    assert.equal(scan.redactions, 0);

    // A bad key is refused with 401.
    const bad = memoryStorage();
    await setFlagsSettings(bad, { enabled: true, baseUrl: real.base, apiKey: `smk_${'x'.repeat(40)}` });
    const refused = await reportFlag(bad, { kind: 'evasion', rule: 'r', label: 'label', site: 'grok.com' }, { now });
    assert.equal(refused.stopped, 'key-rejected');
  } finally { await real.stop(); }
});
