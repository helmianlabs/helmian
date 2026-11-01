// Scribe approvals: the owner's own page for deciding the Guard approval
// requests raised by actions taken through this door. It lives in Scribe
// itself (this server), never in another product's app: the owner signs in
// with the same Scribe passphrase used at the consent screen, sees the
// pending requests Guard is holding, and approves or denies them here.
// The door calls Executive Guard's approver API server-side with its own
// approver credential (GUARD_APPROVER_TOKEN); the credential never reaches
// the browser. Fail closed: no credential configured, no routes.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeEqual(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

const SESSION_TTL_MS = 30 * 60 * 1000;

const CSS = `
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#0b0d10; color:#e9eef3;
         display:flex; min-height:100vh; align-items:flex-start; justify-content:center; margin:0; padding:28px 0; }
  .card { background:#15191e; border:1px solid #262b31; border-radius:14px; padding:32px 28px;
          width:min(620px, 94vw); box-shadow:0 10px 40px rgba(0,0,0,.5); }
  h1 { font-size:20px; margin:0 0 6px; }
  p.sub { color:#9aa6b2; margin:0 0 16px; font-size:14px; line-height:1.5; }
  label { display:block; font-size:13px; margin-bottom:6px; color:#c7d0d9; }
  input[type=password] { width:100%; box-sizing:border-box; padding:11px 12px; border-radius:8px;
            border:1px solid #2b323a; background:#0e1216; color:#e9eef3; font-size:15px; }
  button { padding:11px 18px; border:0; border-radius:8px; background:#3b82f6; color:#fff;
           font-size:14.5px; font-weight:600; cursor:pointer; }
  button.deny { background:transparent; color:#9aa6b2; border:1px solid #2b323a; }
  button.big { width:100%; margin-top:18px; padding:12px; font-size:15px; }
  .error { color:#ff6b6b; font-size:13px; margin:0 0 14px; }
  .flash { color:#7ee2a0; font-size:13.5px; margin:0 0 14px; }
  .req { background:#1d2329; border:1px solid #2b323a; border-radius:10px; padding:14px 16px; margin-bottom:14px; }
  .req .sum { font-size:15px; color:#e9eef3; line-height:1.45; }
  .req .meta { font-size:12.5px; color:#9aa6b2; margin-top:6px; line-height:1.5; }
  .req form { display:flex; gap:10px; margin-top:12px; }
  .empty { color:#9aa6b2; font-size:14.5px; line-height:1.55; }
  .foot { margin-top:18px; font-size:12px; color:#6b7682; line-height:1.5; }`;

function shell(title, inner) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
  <div class="card">
${inner}
  </div>
</body>
</html>`;
}

function fmtTime(v) {
  if (!v) return '';
  const ms = Number(v) > 1e12 ? Number(v) : Number(v) * 1000;
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
}

export function approvalsRouter({ config }) {
  const router = express.Router();
  const token = config.guard?.approverToken;
  if (!token) return router;
  const guardUrl = String(config.guard.url || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const secret = createHash('sha256').update(`scribe-approvals:${config.passphrase}`).digest();
  const sign = (msg) => createHmac('sha256', secret).update(msg).digest('base64url');

  function makeSession() {
    const exp = Date.now() + SESSION_TTL_MS;
    return `${exp}.${sign(`session:${exp}`)}`;
  }
  function sessionOk(value) {
    if (!value || typeof value !== 'string') return false;
    const dot = value.lastIndexOf('.');
    if (dot < 1) return false;
    const exp = Number(value.slice(0, dot));
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    return safeEqual(value.slice(dot + 1), sign(`session:${exp}`));
  }
  const csrfFor = (session) => sign(`csrf:${session}`);
  function readSession(req) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx < 1) continue;
      if (part.slice(0, idx).trim() === 'scribe_appr') return decodeURIComponent(part.slice(idx + 1).trim());
    }
    return null;
  }
  async function guard(path, init = {}) {
    const res = await fetch(`${guardUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  }

  const strikes = { count: 0, lockedUntil: 0 };

  function loginPage(error) {
    const errorBlock = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
    return shell('Scribe approvals', `
    <h1>Scribe approvals</h1>
    <p class="sub">Actions your AIs take through Scribe wait for your decision here. Sign in with your Scribe passphrase.</p>
    ${errorBlock}
    <form method="POST" action="/approvals/login">
      <label for="passphrase">Passphrase</label>
      <input id="passphrase" name="passphrase" type="password" autocomplete="off" autofocus required />
      <button type="submit" class="big">Sign in</button>
    </form>
    <p class="foot">This page is part of Scribe. Nothing here connects to any other product.</p>`);
  }

  function listPage(approvals, csrf, flash) {
    const flashBlock = flash ? `<p class="flash">${escapeHtml(flash)}</p>` : '';
    const rows = approvals.map((a) => {
      const summary = a.summary || a.action?.summary || a.kind || 'Action';
      const meta = [
        a.deviceId ? `Device: ${a.deviceId}` : '',
        a.createdAt ? `Asked: ${fmtTime(a.createdAt)}` : '',
        a.expiresAt ? `Expires: ${fmtTime(a.expiresAt)}` : '',
      ].filter(Boolean).join(' &middot; ');
      return `
    <div class="req">
      <div class="sum">${escapeHtml(summary)}</div>
      <div class="meta">${meta}</div>
      <form method="POST" action="/approvals/${encodeURIComponent(a.id)}/decide">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
        <button type="submit" name="verdict" value="approve">Approve</button>
        <button type="submit" name="verdict" value="deny" class="deny">Deny</button>
      </form>
    </div>`;
    }).join('');
    const body = approvals.length
      ? rows
      : '<p class="empty">Nothing is waiting for a decision. When an AI working through Scribe asks to change something, the request appears here.</p>';
    return shell('Scribe approvals', `
    <h1>Scribe approvals</h1>
    <p class="sub">Every action below was requested through Scribe and is waiting for you. Nothing runs until you approve it.</p>
    ${flashBlock}
    ${body}
    <p class="foot">Refresh this page to see new requests. Approvals expire on their own if you do not decide.</p>`);
  }

  router.get('/approvals', async (req, res) => {
    const session = readSession(req);
    if (!sessionOk(session)) return res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(loginPage());
    let r;
    try { r = await guard('/v1/approvals?status=pending'); } catch { r = { status: 502, body: null }; }
    if (r.status !== 200) return res.status(502).set('Content-Type', 'text/html; charset=utf-8').send(loginPage('Approvals are unavailable right now. Please try again.'));
    const flash = req.query?.done ? String(req.query.done).slice(0, 120) : '';
    return res.status(200).set('Content-Type', 'text/html; charset=utf-8')
      .send(listPage(Array.isArray(r.body?.approvals) ? r.body.approvals : [], csrfFor(session), flash));
  });

  router.post('/approvals/login', express.urlencoded({ extended: false }), (req, res) => {
    if (Date.now() < strikes.lockedUntil) {
      return res.status(429).set('Content-Type', 'text/html; charset=utf-8').send(loginPage('Too many attempts. Try again in a few minutes.'));
    }
    if (!safeEqual(String(req.body?.passphrase || ''), config.passphrase)) {
      strikes.count += 1;
      if (strikes.count >= 5) { strikes.lockedUntil = Date.now() + 15 * 60 * 1000; strikes.count = 0; }
      return res.status(401).set('Content-Type', 'text/html; charset=utf-8').send(loginPage('Incorrect passphrase. Please try again.'));
    }
    strikes.count = 0;
    const s = makeSession();
    res.set('Set-Cookie', `scribe_appr=${encodeURIComponent(s)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
    return res.redirect(302, '/approvals');
  });

  router.post('/approvals/:id/decide', express.urlencoded({ extended: false }), async (req, res) => {
    const session = readSession(req);
    if (!sessionOk(session)) return res.status(401).set('Content-Type', 'text/html; charset=utf-8').send(loginPage('Please sign in again.'));
    if (!safeEqual(String(req.body?.csrf || ''), csrfFor(session))) return res.status(403).send('Invalid form token.');
    const approve = String(req.body?.verdict || '') === 'approve';
    let r;
    try {
      r = await guard(`/v1/approvals/${encodeURIComponent(String(req.params.id))}/decide`, {
        method: 'POST',
        body: JSON.stringify({ approve }),
      });
    } catch { r = { status: 502, body: null }; }
    const msg = r.status === 200
      ? (approve ? 'Approved. The action can now run.' : 'Denied. The action will not run.')
      : 'That request could not be decided. It may have expired.';
    return res.redirect(302, `/approvals?done=${encodeURIComponent(msg)}`);
  });

  return router;
}
