import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateBrowserUrl,
  isPublicIpLiteral,
  checkBrowserRateLimit,
  clearBrowserRateLimits,
  handleBrowserRoute,
  BROWSER_NAVIGATE_PATH,
} from '../src/cloud/browser-launcher.mjs';
import { TenantAuthorizationError } from '../src/core/tenant-context.mjs';

const ACTOR = { tenantId: 'tenant-a', subject: 'user-1', role: 'member', sessionId: 's', requestId: 'r' };

// DNS stub: resolve every hostname to a single public IPv4 address.
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const privateDns = async () => [{ address: '10.9.8.7', family: 4 }];
const failingDns = async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); };

// --- isPublicIpLiteral: mirrors BrowserReferenceReader.IsPublicAddress ---

test('isPublicIpLiteral accepts ordinary public IPv4', async () => {
  assert.equal(isPublicIpLiteral('8.8.8.8'), true);
  assert.equal(isPublicIpLiteral('1.1.1.1'), true);
  assert.equal(isPublicIpLiteral('223.255.255.255'), true);
});

test('isPublicIpLiteral rejects private, loopback and reserved IPv4', async () => {
  for (const ip of ['0.1.2.3', '10.0.0.1', '127.0.0.1', '169.254.169.254', '192.168.1.1', '192.0.2.1', '224.0.0.1', '203.0.113.9', '198.51.100.7']) {
    assert.equal(isPublicIpLiteral(ip), false, ip);
  }
  // Carrier-grade NAT boundaries: 100.64/10 denied, 100.128/9 allowed.
  assert.equal(isPublicIpLiteral('100.64.0.1'), false);
  assert.equal(isPublicIpLiteral('100.127.255.255'), false);
  assert.equal(isPublicIpLiteral('100.128.0.1'), true);
  // 172.16/12 boundaries.
  assert.equal(isPublicIpLiteral('172.15.255.255'), true);
  assert.equal(isPublicIpLiteral('172.16.0.1'), false);
  assert.equal(isPublicIpLiteral('172.31.255.255'), false);
  assert.equal(isPublicIpLiteral('172.32.0.1'), true);
  // Benchmarking ranges.
  assert.equal(isPublicIpLiteral('198.18.0.1'), false);
  assert.equal(isPublicIpLiteral('198.20.0.1'), true);
});

test('isPublicIpLiteral rejects non-public IPv6', async () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fec0::1', 'ff02::1', 'fc00::1', 'fd00::1', '2001:db8::1']) {
    assert.equal(isPublicIpLiteral(ip), false, ip);
  }
  assert.equal(isPublicIpLiteral('2606:4700:4700::1111'), true);
  assert.equal(isPublicIpLiteral('2001:4860:4860::8888'), true);
});

test('isPublicIpLiteral judges IPv4-mapped IPv6 as IPv4', async () => {
  assert.equal(isPublicIpLiteral('::ffff:8.8.8.8'), true);
  assert.equal(isPublicIpLiteral('::ffff:10.0.0.1'), false);
});

test('isPublicIpLiteral returns null for non-literals', async () => {
  assert.equal(isPublicIpLiteral('example.com'), null);
  assert.equal(isPublicIpLiteral('not an ip'), null);
});

// --- validateBrowserUrl: mirrors EmbeddedBrowserPolicy ---

test('validateBrowserUrl accepts a public HTTPS URL', async () => {
  const d = await validateBrowserUrl('https://example.com', { resolveHost: publicDns });
  assert.equal(d.allowed, true);
  assert.equal(d.url, 'https://example.com/');
});

test('validateBrowserUrl prepends https when no scheme is given', async () => {
  const d = await validateBrowserUrl('example.com/path?q=1', { resolveHost: publicDns });
  assert.equal(d.allowed, true);
  assert.equal(d.url, 'https://example.com/path?q=1');
});

test('validateBrowserUrl rejects non-HTTPS schemes', async () => {
  for (const url of ['http://example.com', 'file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)']) {
    const d = await validateBrowserUrl(url, { resolveHost: publicDns });
    assert.equal(d.allowed, false, url);
  }
});

test('validateBrowserUrl rejects embedded credentials', async () => {
  const d = await validateBrowserUrl('https://user:pass@example.com', { resolveHost: publicDns });
  assert.equal(d.allowed, false);
});

test('validateBrowserUrl rejects localhost', async () => {
  for (const url of ['https://localhost', 'https://localhost:3000/x', 'https://app.localhost']) {
    const d = await validateBrowserUrl(url, { resolveHost: publicDns });
    assert.equal(d.allowed, false, url);
  }
});

test('validateBrowserUrl rejects private IP literals without DNS', async () => {
  let dnsCalls = 0;
  const countingDns = async (...args) => { dnsCalls += 1; return publicDns(...args); };
  for (const url of ['https://127.0.0.1', 'https://10.1.2.3', 'https://192.168.0.1', 'https://[::1]']) {
    const d = await validateBrowserUrl(url, { resolveHost: countingDns });
    assert.equal(d.allowed, false, url);
  }
  assert.equal(dnsCalls, 0);
});

test('validateBrowserUrl rejects hostnames resolving to private addresses', async () => {
  const d = await validateBrowserUrl('https://intranet.example', { resolveHost: privateDns });
  assert.equal(d.allowed, false);
});

test('validateBrowserUrl rejects unresolvable hosts', async () => {
  const d = await validateBrowserUrl('https://no-such-host.invalid', { resolveHost: failingDns });
  assert.equal(d.allowed, false);
});

test('validateBrowserUrl rejects empty and overlong input', async () => {
  assert.equal((await validateBrowserUrl('', { resolveHost: publicDns })).allowed, false);
  assert.equal((await validateBrowserUrl('   ', { resolveHost: publicDns })).allowed, false);
  assert.equal((await validateBrowserUrl(`https://example.com/${'x'.repeat(4096)}`, { resolveHost: publicDns })).allowed, false);
});

// --- rate limit ---

test('checkBrowserRateLimit allows 30 then blocks', async () => {
  clearBrowserRateLimits();
  const key = 'tenant-a:user-1';
  for (let i = 0; i < 30; i++) assert.equal(checkBrowserRateLimit(key, 1_000 + i), true);
  assert.equal(checkBrowserRateLimit(key, 2_000), false);
  // A different actor is unaffected.
  assert.equal(checkBrowserRateLimit('tenant-a:user-2', 2_000), true);
  // The window slides: after 60s the bucket is fresh.
  assert.equal(checkBrowserRateLimit(key, 1_000 + 60_001), true);
  clearBrowserRateLimits();
});

// --- route handling ---

function auditPool() {
  const client = {
    async query(sql, params) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
      if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: ACTOR.role }] };
      if (q.includes('insert into helmion.audit_events')) {
        assert.equal(params[5], 'browser.navigation_requested');
        return { rowCount: 1, rows: [{ id: 77 }] };
      }
      throw new Error(`unexpected query ${q}`);
    },
    release() {},
  };
  return { connect: async () => client };
}

function routeHarness({ body = {} } = {}) {
  const sent = {};
  return {
    sent,
    args: {
      request: { method: 'POST', headers: {} },
      response: {},
      requestUrl: new URL(BROWSER_NAVIGATE_PATH, 'http://local'),
      pool: auditPool(),
      activeTenantActor: async () => ACTOR,
      send: (res, status, payload) => { sent.status = status; sent.payload = JSON.parse(payload); },
      readJsonObject: async () => body,
      exactKeys: (value, keys) => {
        for (const k of Object.keys(value)) if (!keys.includes(k)) throw new Error('unexpected field');
      },
      TenantAuthorizationError,
    },
  };
}

test('browser route accepts a public IP literal and appends an audit event', async () => {
  clearBrowserRateLimits();
  const { args, sent } = routeHarness({ body: { url: 'https://8.8.8.8' } });
  assert.equal(await handleBrowserRoute(args), true);
  assert.equal(sent.status, 200);
  assert.equal(sent.payload.valid, true);
  assert.equal(sent.payload.ok, true);
  assert.equal(sent.payload.url, 'https://8.8.8.8/');
  assert.equal(sent.payload.receiptId, '77');
});

test('browser route rejects a private URL with the policy message', async () => {
  clearBrowserRateLimits();
  const { args, sent } = routeHarness({ body: { url: 'https://192.168.1.1' } });
  assert.equal(await handleBrowserRoute(args), true);
  assert.equal(sent.status, 400);
  assert.equal(sent.payload.code, 'BROWSER_URL_REJECTED');
  assert.match(sent.payload.message, /private-network/);
});

test('browser route rejects unexpected body fields', async () => {
  clearBrowserRateLimits();
  const { args, sent } = routeHarness({ body: { url: 'https://8.8.8.8', tenantId: 'evil' } });
  assert.equal(await handleBrowserRoute(args), true);
  assert.equal(sent.status, 400);
  assert.equal(sent.payload.code, 'BROWSER_NAVIGATE_INVALID');
});

test('browser route ignores non-browser paths', async () => {
  clearBrowserRateLimits();
  const { args } = routeHarness({ body: { url: 'https://8.8.8.8' } });
  args.requestUrl = new URL('/api/admin/other', 'http://local');
  assert.equal(await handleBrowserRoute(args), false);
});
