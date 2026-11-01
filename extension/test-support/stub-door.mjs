// A stub of the Scribe approvals DOOR, for approvals-popup.test.mjs.
//
// It implements the door's REAL contract, read line by line from the door's
// own source (helmian-door app/src/approvals.mjs — the file that serves
// https://connect.helmian.cloud/approvals in production):
//   - POST /approvals/login: urlencoded `passphrase`; success sets the
//     `scribe_appr` cookie and 302s to /approvals (approvals.mjs:179-194);
//     wrong passphrase -> 401 login page with the error in <p class="error">;
//     5 strikes -> 15-minute lockout (approvals.mjs:133, 180-186).
//   - The session value is `<exp>.<HMAC>` with the HMAC keyed by
//     sha256("scribe-approvals:" + passphrase), 30-minute fixed expiry
//     (approvals.mjs:25, 84-101). csrf = sign("csrf:" + session) (:102).
//   - GET /approvals: no session -> login page; session -> the pending list
//     rendered with .req/.sum/.meta rows and a hidden csrf field per row
//     (approvals.mjs:143-178); Guard down -> 502 login page + "Approvals are
//     unavailable right now. Please try again."
//   - POST /approvals/:id/decide: session + csrf + verdict; forwards to the
//     (stubbed) Guard and 302s to /approvals?done=<message> with the door's
//     own outcome sentences (approvals.mjs:196-206).
// The Guard behind the door is part of the stub: `pending` is its list, and
// setting `guardDown` makes its answers fail the way a dead Guard fails.
//
// jarFetch() emulates what the BROWSER does for the extension in production:
// a cookie jar that stores Set-Cookie from every response (including
// redirect hops) and sends the cookies back. The client under test never
// touches the cookie itself, in the stub exactly as in the browser.

import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTime(v) {
  if (!v) return '';
  const ms = Number(v) > 1e12 ? Number(v) : Number(v) * 1000;
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
}

export async function startStubDoor({ passphrase = 'test-passphrase', pending = [], sessionTtlMs = 30 * 60 * 1000 } = {}) {
  const secret = createHash('sha256').update(`scribe-approvals:${passphrase}`).digest();
  const sign = (msg) => createHmac('sha256', secret).update(msg).digest('base64url');
  const stub = {
    url: null,
    pending: pending.map((a) => ({ ...a })),
    decisions: [],
    hits: [],
    guardDown: false,
    timeOffsetMs: 0,
    strikes: { count: 0, lockedUntil: 0 },
    close: null,
  };
  const now = () => Date.now() + stub.timeOffsetMs;

  function sessionOk(value) {
    if (!value || typeof value !== 'string') return false;
    const dot = value.lastIndexOf('.');
    if (dot < 1) return false;
    const exp = Number(value.slice(0, dot));
    if (!Number.isFinite(exp) || exp < now()) return false;
    return value.slice(dot + 1) === sign(`session:${exp}`);
  }
  function readSession(req) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx < 1) continue;
      if (part.slice(0, idx).trim() === 'scribe_appr') return decodeURIComponent(part.slice(idx + 1).trim());
    }
    return null;
  }
  function loginPage(error) {
    const errorBlock = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
    return `<!doctype html><html><head><title>Scribe approvals</title></head><body><div class="card">
    <h1>Scribe approvals</h1>
    ${errorBlock}
    <form method="POST" action="/approvals/login">
      <label for="passphrase">Passphrase</label>
      <input id="passphrase" name="passphrase" type="password" autocomplete="off" autofocus required />
      <button type="submit" class="big">Sign in</button>
    </form></div></body></html>`;
  }
  function listPage(approvals, csrf, flash) {
    const flashBlock = flash ? `<p class="flash">${escapeHtml(flash)}</p>` : '';
    const rows = approvals.map((a) => {
      const meta = [
        a.deviceId ? `Device: ${a.deviceId}` : '',
        a.createdAt ? `Asked: ${fmtTime(a.createdAt)}` : '',
        a.expiresAt ? `Expires: ${fmtTime(a.expiresAt)}` : '',
      ].filter(Boolean).join(' &middot; ');
      return `
    <div class="req">
      <div class="sum">${escapeHtml(a.summary || 'Action')}</div>
      <div class="meta">${meta}</div>
      <form method="POST" action="/approvals/${encodeURIComponent(a.id)}/decide">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
        <button type="submit" name="verdict" value="approve">Approve</button>
        <button type="submit" name="verdict" value="deny" class="deny">Deny</button>
      </form>
    </div>`;
    }).join('');
    const body = approvals.length ? rows : '<p class="empty">Nothing is waiting for a decision.</p>';
    return `<!doctype html><html><head><title>Scribe approvals</title></head><body><div class="card">
    <h1>Scribe approvals</h1>
    ${flashBlock}
    ${body}</div></body></html>`;
  }

  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://stub');
    stub.hits.push(`${req.method} ${u.pathname}`);
    const send = (status, html, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(html);
    };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      if (req.method === 'POST' && u.pathname === '/approvals/login') {
        if (now() < stub.strikes.lockedUntil) return send(429, loginPage('Too many attempts. Try again in a few minutes.'));
        if (form.get('passphrase') !== passphrase) {
          stub.strikes.count += 1;
          if (stub.strikes.count >= 5) { stub.strikes.lockedUntil = now() + 15 * 60 * 1000; stub.strikes.count = 0; }
          return send(401, loginPage('Incorrect passphrase. Please try again.'));
        }
        stub.strikes.count = 0;
        const exp = now() + sessionTtlMs;
        const s = `${exp}.${sign(`session:${exp}`)}`;
        return send(302, '', {
          location: '/approvals',
          'set-cookie': `scribe_appr=${encodeURIComponent(s)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionTtlMs / 1000}`,
        });
      }
      if (req.method === 'GET' && u.pathname === '/approvals') {
        const session = readSession(req);
        if (!sessionOk(session)) return send(200, loginPage());
        if (stub.guardDown) return send(502, loginPage('Approvals are unavailable right now. Please try again.'));
        const flash = u.searchParams.get('done') ? String(u.searchParams.get('done')).slice(0, 120) : '';
        return send(200, listPage(stub.pending, sign(`csrf:${session}`), flash));
      }
      const decide = u.pathname.match(/^\/approvals\/([^/]+)\/decide$/);
      if (req.method === 'POST' && decide) {
        const session = readSession(req);
        if (!sessionOk(session)) return send(401, loginPage('Please sign in again.'));
        if (form.get('csrf') !== sign(`csrf:${session}`)) { res.writeHead(403); return res.end('Invalid form token.'); }
        const id = decodeURIComponent(decide[1]);
        const approve = form.get('verdict') === 'approve';
        const idx = stub.pending.findIndex((a) => a.id === id);
        if (stub.guardDown || idx < 0) {
          return send(302, '', { location: `/approvals?done=${encodeURIComponent('That request could not be decided. It may have expired.')}` });
        }
        stub.pending.splice(idx, 1);
        stub.decisions.push({ id, approve });
        const msg = approve ? 'Approved. The action can now run.' : 'Denied. The action will not run.';
        return send(302, '', { location: `/approvals?done=${encodeURIComponent(msg)}` });
      }
      res.writeHead(404);
      return res.end('not found');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.url = `http://127.0.0.1:${server.address().port}`;
  stub.close = () => new Promise((resolve) => server.close(resolve));
  return stub;
}

/** A fetch that keeps cookies the way a browser jar does (see header). */
export function jarFetch() {
  const jar = new Map(); // origin -> Map(name -> value)
  const impl = async (url, init = {}) => {
    let current = String(url);
    let method = init.method || 'GET';
    let body = init.body;
    const headers = { ...(init.headers || {}) };
    for (let hop = 0; hop < 6; hop += 1) {
      const origin = new URL(current).origin;
      const cookies = jar.get(origin);
      const h = { ...headers };
      if (cookies && cookies.size) h.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(current, { method, body, headers: h, redirect: 'manual' });
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const sc of setCookies) {
        const pair = sc.split(';')[0];
        const idx = pair.indexOf('=');
        if (idx < 1) continue;
        if (!jar.has(origin)) jar.set(origin, new Map());
        jar.get(origin).set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
        const loc = new URL(res.headers.get('location'), current).toString();
        await res.text();
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
        current = loc;
        continue;
      }
      const text = await res.text();
      return { status: res.status, text: async () => text, headers: res.headers };
    }
    throw new Error('jarFetch: too many redirects');
  };
  impl.jar = jar;
  return impl;
}
