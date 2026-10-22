// A stand-in for the Flags API in troy83352/shared-memory-mcp (branch saas,
// docs/FLAGS_API.md; behaviour copied from server.src/app/src/saas/app.ts at
// 052f2bd). Same paths, auth, validation, status codes and response shapes;
// the scanner is a tiny subset (card number, GitHub token, Stripe webhook
// secret, private key, `rm -rf /`). Records every request so tests can check what left the browser.
import http from 'node:http';

export const MOCK_KEY = 'smk_mockmockmockmockmockmockmockmockmock01';
export const READ_ONLY_KEY = 'smk_readonlyreadonlyreadonlyreadonly0001';
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const CATEGORIES = ['secret', 'pii', 'harmful_code', 'hedging', 'privacy', 'moderation', 'other'];

function luhn(d) {
  let sum = 0; let alt = false;
  for (let i = d.length - 1; i >= 0; i -= 1) { let n = d.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}

export function mockScan(text) {
  const findings = [];
  let redactions = 0;
  let redacted = String(text)
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
      if (!luhn(m.replace(/\D/g, ''))) return m;
      redactions += 1; findings.push({ category: 'pii', rule: 'pii.card_number', severity: 'high', reason: 'A payment card number was found.' });
      return '[REDACTED:card_number]';
    })
    .replace(/\bgh[pousr]_[A-Za-z0-9]{36}\b/g, () => {
      redactions += 1; findings.push({ category: 'secret', rule: 'secret.github_token', severity: 'critical', reason: 'A GitHub token was found.' });
      return '[REDACTED:github_token]';
    })
    .replace(/\bwhsec_[A-Za-z0-9]{20,}\b/g, () => {
      redactions += 1; findings.push({ category: 'secret', rule: 'secret.stripe_webhook_secret', severity: 'high', reason: 'A Stripe webhook signing secret was found.' });
      return '[REDACTED:stripe_webhook_secret]';
    })
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, () => {
      redactions += 1; findings.push({ category: 'secret', rule: 'secret.private_key', severity: 'critical', reason: 'A private key was found.' });
      return '[REDACTED:private_key]';
    });
  if (/\brm\s+-rf\s+\/(?:\s|$)/.test(redacted)) findings.push({ category: 'harmful_code', rule: 'harmful.rm_rf_root', severity: 'critical', reason: 'Deletes the whole filesystem.', snippet: 'rm -rf /' });
  return { redacted, redactions, findings };
}

export async function startMockFlagsApi({ keys = { [MOCK_KEY]: ['flags.write', 'flags.read'], [READ_ONLY_KEY]: ['flags.read'] }, callsPerDay = 300 } = {}) {
  const requests = [];
  const flags = [];
  const state = { failWith: null, calls: 0, callsPerDay, revoked: new Set(), delayMs: 0 };
  let nextId = 1;
  let clock = Date.parse('2026-10-22T09:30:00.000Z');

  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://mock');
      let body = null;
      const isJson = String(req.headers['content-type'] || '').includes('application/json');
      if (raw && isJson) { try { body = JSON.parse(raw); } catch { send(res, 400, { error: 'Bad JSON.' }); return; } }
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, raw, body });
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.failWith) { send(res, state.failWith, { error: 'Something went wrong.' }); return; }

      const route = `${req.method} ${url.pathname}`;
      const scopeFor = { 'GET /api/flags': 'flags.read', 'POST /api/flags': 'flags.write', 'POST /api/flags/scan': 'flags.read' }[route];
      if (!scopeFor) { send(res, 404, { error: 'not_found' }); return; }
      // app.ts caller(): only `Bearer smk_…` counts as an API key; anything else
      // falls through to the session check.
      const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(smk_\S+)$/)?.[1];
      if (!bearer) { send(res, 401, { error: 'Sign in first.' }); return; }
      const scopes = state.revoked.has(bearer) ? null : keys[bearer];
      if (!scopes || !scopes.includes(scopeFor)) { send(res, 401, { error: 'Invalid API key or missing scope.' }); return; }
      state.calls += 1;
      if (state.calls > state.callsPerDay) { send(res, 402, { error: `Daily limit reached: the Free plan allows ${state.callsPerDay} calls a day. Upgrade on your dashboard or try again tomorrow (UTC).`, limit: 'calls' }); return; }

      if (route === 'POST /api/flags') {
        const b = body ?? {};
        if (!SEVERITIES.includes(b.severity) || !CATEGORIES.includes(b.category) || typeof b.reason !== 'string' || b.reason.length < 3 || b.reason.length > 1000) {
          send(res, 400, { error: `Need severity (low|medium|high|critical), category (${CATEGORIES.join('|')}) and reason (3-1000 chars).` }); return;
        }
        const scan = typeof b.excerpt === 'string' ? mockScan(b.excerpt.slice(0, 5000)) : null;
        const created = () => { clock += 1000; return new Date(clock).toISOString(); };
        const ctx = {};
        if (typeof b.url === 'string') ctx.url = b.url.slice(0, 500);
        if (b.context && typeof b.context === 'object') ctx.extra = b.context;
        const out = [{
          id: nextId++, tenant_id: 'tenant-mock', severity: b.severity, category: b.category, rule: typeof b.rule === 'string' ? b.rule.slice(0, 80) : null,
          origin: 'api', source_ai: typeof b.source_ai === 'string' ? b.source_ai : null,
          reporter: typeof b.reporter === 'string' ? `key:Guard extension (${b.reporter.slice(0, 40)})` : 'key:Guard extension',
          reason: b.reason, excerpt: scan ? scan.redacted : null, message_id: null, context: ctx, created_at: created(),
        }];
        for (const f of scan ? scan.findings.filter((x) => x.category !== 'hedging') : []) {
          out.push({ id: nextId++, tenant_id: 'tenant-mock', severity: f.severity, category: f.category, rule: f.rule, origin: 'scanner', source_ai: b.source_ai ?? null, reporter: 'server', reason: f.reason, excerpt: scan.redacted, message_id: null, context: {}, created_at: created() });
        }
        flags.push(...out);
        send(res, 201, { flags: out, redactions: scan ? scan.redactions : 0, alert: { sent: false, email: 'stubbed', webhook: 'stubbed' } });
        return;
      }
      if (route === 'GET /api/flags') {
        const q = url.searchParams;
        const min = SEVERITIES.includes(q.get('min_severity')) ? SEVERITIES.indexOf(q.get('min_severity')) : 0;
        const since = q.get('since') && !Number.isNaN(Date.parse(q.get('since'))) ? q.get('since') : null;
        const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), 500);
        const rows = flags
          .filter((f) => SEVERITIES.indexOf(f.severity) >= min)
          .filter((f) => !q.get('category') || f.category === q.get('category'))
          .filter((f) => !since || f.created_at >= since) // inclusive, like the real query
          .sort((a, b) => (b.created_at < a.created_at ? -1 : b.created_at > a.created_at ? 1 : b.id - a.id))
          .slice(0, limit);
        send(res, 200, { installed: true, flags: rows });
        return;
      }
      const text = typeof body?.text === 'string' ? body.text.slice(0, 50000) : '';
      const s = mockScan(text);
      send(res, 200, { redacted: s.redacted, redactions: s.redactions, findings: s.findings });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, key: MOCK_KEY, requests, flags, state, close: () => new Promise((r) => server.close(r)) };
}

export function memoryStorage() {
  const bag = new Map();
  return {
    bag,
    async get(key) { return bag.has(key) ? structuredClone(bag.get(key)) : undefined; },
    async set(key, value) { bag.set(key, structuredClone(value)); },
  };
}
