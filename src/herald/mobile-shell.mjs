// Helmian Herald Phase 1 PWA shell. Static source only: no embedded token,
// workspace path, provider key, relay URL, or user data.

export const HERALD_MANIFEST = JSON.stringify({
  name: 'Helmian Herald',
  short_name: 'Herald',
  description: 'Paired Helmian phone companion for visible, project-scoped work.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0b1116',
  theme_color: '#141d24',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
}, null, 2);

export const HERALD_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<rect width="128" height="128" rx="28" fill="#141d24"/>
<path d="M31 31h15v25h36V31h15v66H82V70H46v27H31z" fill="#dce5ea"/>
</svg>`;

export const HERALD_SERVICE_WORKER = `
const CACHE = 'helmian-herald-shell-v1';
const SHELL = ['/', '/app.js', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || caches.match('/'))));
});
`;

export const HERALD_APP_JS = `
const byId = (id) => document.getElementById(id);
const DEVICE_KEY = 'helmian-herald-device-id-v1';
let lastStatus = null;
let activeContext = null;
let reviewedInstruction = null;
let reviewedApproval = null;

function randomId(prefix) {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return prefix + '-' + Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function deviceId() {
  let value = localStorage.getItem(DEVICE_KEY);
  if (!value) {
    value = randomId('phone');
    localStorage.setItem(DEVICE_KEY, value);
  }
  return value;
}

function setConnection(label, tone) {
  const badge = byId('connection');
  badge.textContent = label;
  badge.dataset.tone = tone;
}

function showPairing(message = '') {
  byId('pairing').hidden = false;
  byId('status').hidden = true;
  byId('pair-message').textContent = message;
}

function showStatus(status) {
  lastStatus = status;
  byId('pairing').hidden = true;
  byId('status').hidden = false;
  byId('state').textContent = status.status.state.toUpperCase();
  byId('headline').textContent = status.status.headline;
  byId('detail').textContent = status.status.detail;
  byId('lease').textContent = status.lease.state;
  byId('refusals').textContent = String(status.activity.refusedChanges);
  byId('blocks').textContent = String(status.activity.blockedCommands);
  byId('generated').textContent = status.generatedAt
    ? new Date(status.generatedAt).toLocaleString()
    : 'unknown';
  setConnection('PAIRED · DESKTOP OWNED', 'neutral');
}

function renderSession(context) {
  activeContext = context;
  byId('session-card').hidden = false;
  byId('project-name').textContent = context.project?.name || 'No project selected';
  byId('session-name').textContent = context.session?.name || 'No active session';
  byId('agent-name').textContent = context.agent?.name || 'No agent selected';
  byId('guard-state').textContent = context.guard?.state || 'unknown';
  byId('outputs').replaceChildren(...(context.outputs || []).map((output) => {
    const item = document.createElement('div');
    item.className = 'output';
    item.textContent = output.text || '';
    return item;
  }));
  byId('approvals').replaceChildren(...(context.approvals || []).map((approval) => {
    const item = document.createElement('div');
    item.className = 'approval';
    const summary = document.createElement('div');
    summary.textContent = approval.summary || 'Desktop approval waiting';
    const allow = document.createElement('button');
    allow.textContent = 'Review Allow once';
    allow.addEventListener('click', () => reviewApproval(approval, 'allow-once'));
    const deny = document.createElement('button');
    deny.textContent = 'Review Deny';
    deny.className = 'secondary';
    deny.addEventListener('click', () => reviewApproval(approval, 'deny'));
    item.append(summary, allow, deny);
    return item;
  }));
  const voice = context.voice || {};
  byId('voice-button').disabled = voice.available !== true;
  byId('voice-state').textContent = voice.available === true
    ? 'Voice input is available. Starting it always requires a deliberate tap.'
    : (voice.reason || 'Voice input is unavailable from this desktop session.');
}

function reviewApproval(approval, decision) {
  if (!activeContext?.project?.id || !activeContext?.session?.id || !approval?.id) return;
  reviewedApproval = {
    approvalId: approval.id,
    decision,
    projectId: activeContext.project.id,
    sessionId: activeContext.session.id,
  };
  byId('approval-preview').textContent = decision === 'allow-once'
    ? 'Allow this one desktop request once'
    : 'Deny this desktop request';
  byId('approval-confirm').hidden = false;
  byId('approval-state').textContent = 'Review the decision, then confirm it explicitly.';
}

async function sendApprovalDecision() {
  if (!reviewedApproval) return;
  const { approvalId, ...body } = reviewedApproval;
  byId('approval-state').textContent = 'Sending the decision to Helmian Desktop…';
  const response = await fetch('/api/approvals/' + encodeURIComponent(approvalId) + '/decision', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-helmian-device-id': deviceId(), 'x-helmian-nonce': randomId('nonce') },
    body: JSON.stringify({ ...body, confirmed: true }),
  }).catch(() => null);
  if (!response) {
    byId('approval-state').textContent = 'Desktop offline. No decision was applied.';
    return;
  }
  const result = await response.json();
  byId('approval-state').textContent = result.message || (response.ok ? 'Decision recorded.' : 'Decision refused.');
  if (response.ok) {
    reviewedApproval = null;
    byId('approval-confirm').hidden = true;
    await refreshSession();
  }
}

async function refreshSession() {
  try {
    const response = await fetch('/api/session', {
      credentials: 'same-origin', cache: 'no-store',
      headers: { 'x-helmian-device-id': deviceId(), 'x-helmian-nonce': randomId('nonce') },
    });
    if (response.status === 503) {
      activeContext = null;
      byId('session-card').hidden = false;
      byId('project-name').textContent = 'Desktop unavailable';
      byId('session-name').textContent = 'Instructions and approvals are denied';
      byId('agent-name').textContent = '—';
      byId('voice-button').disabled = true;
      return;
    }
    if (response.status === 401) {
      byId('session-card').hidden = true;
      return;
    }
    if (!response.ok) throw new Error('session unavailable');
    renderSession(await response.json());
  } catch {
    activeContext = null;
    byId('session-card').hidden = false;
    byId('project-name').textContent = 'Desktop offline';
    byId('session-name').textContent = 'No remote action is available';
    byId('voice-button').disabled = true;
  }
}

function reviewInstruction() {
  const text = byId('instruction').value.trim();
  if (!activeContext?.project?.id || !activeContext?.session?.id || !text) {
    byId('instruction-state').textContent = 'Select a live desktop project/session and enter an instruction first.';
    return;
  }
  reviewedInstruction = { text, projectId: activeContext.project.id, sessionId: activeContext.session.id };
  byId('instruction-preview').textContent = text;
  byId('instruction-confirm').hidden = false;
  byId('instruction-state').textContent = 'Review this exact text, then deliberately send it.';
}

async function sendInstruction() {
  if (!reviewedInstruction) return;
  byId('instruction-state').textContent = 'Sending to the desktop-owned Maestro path…';
  const response = await fetch('/api/instructions', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-helmian-device-id': deviceId(), 'x-helmian-nonce': randomId('nonce') },
    body: JSON.stringify({ ...reviewedInstruction, confirmed: true }),
  }).catch(() => null);
  if (!response) {
    byId('instruction-state').textContent = 'Desktop offline. Nothing was sent.';
    return;
  }
  const result = await response.json();
  byId('instruction-state').textContent = result.message || (response.ok ? 'Instruction accepted by the desktop.' : 'Instruction refused.');
  if (response.ok) {
    byId('instruction').value = '';
    byId('instruction-confirm').hidden = true;
    reviewedInstruction = null;
    await refreshSession();
  }
}

async function pair() {
  const code = byId('pair-code').value.trim();
  byId('pair-message').textContent = 'Pairing…';
  try {
    const response = await fetch('/api/pair', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceId: deviceId() }),
    });
    const result = await response.json();
    if (!response.ok) {
      byId('pair-message').textContent = result.message || 'Pairing was refused.';
      return;
    }
    byId('pair-code').value = '';
    await refresh();
  } catch {
    setConnection('OFFLINE', 'warn');
    byId('pair-message').textContent = 'Helmian is unreachable. Pairing did not complete.';
  }
}

async function refresh() {
  try {
    const response = await fetch('/api/status', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'x-helmian-device-id': deviceId(),
        'x-helmian-nonce': randomId('nonce'),
      },
    });
    if (response.status === 401) {
      setConnection('PAIRING REQUIRED', 'warn');
      showPairing('Enter the short-lived code shown by Helmian Desktop.');
      return;
    }
    if (!response.ok) throw new Error('status unavailable');
    showStatus(await response.json());
    await refreshSession();
  } catch {
    setConnection('OFFLINE', 'warn');
    if (lastStatus) {
      byId('state').textContent = 'OFFLINE';
      byId('headline').textContent = 'Helmian is unreachable';
      byId('detail').textContent = 'The last status is not being presented as current.';
    } else {
      showPairing('Helmian is offline or unreachable on this device.');
    }
  }
}

function updateFreshness() {
  if (!lastStatus?.generatedAt) return;
  const age = Date.now() - new Date(lastStatus.generatedAt).getTime();
  if (age > lastStatus.staleAfterMs) {
    setConnection('STALE', 'warn');
    byId('state').textContent = 'STALE';
    byId('detail').textContent = 'The last local digest is too old to present as current.';
  }
}

byId('pair-button').addEventListener('click', pair);
byId('refresh-button').addEventListener('click', refresh);
byId('review-instruction').addEventListener('click', reviewInstruction);
byId('send-instruction').addEventListener('click', sendInstruction);
byId('cancel-instruction').addEventListener('click', () => {
  reviewedInstruction = null;
  byId('instruction-confirm').hidden = true;
  byId('instruction-state').textContent = 'Nothing was sent.';
});
byId('send-approval').addEventListener('click', sendApprovalDecision);
byId('cancel-approval').addEventListener('click', () => {
  reviewedApproval = null;
  byId('approval-confirm').hidden = true;
  byId('approval-state').textContent = 'No decision was applied.';
});
byId('voice-button').addEventListener('click', () => {
  byId('voice-state').textContent = 'Voice start is not connected in this local build. No microphone or voice host state changed.';
});
byId('pair-code').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') pair();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
refresh();
setInterval(updateFreshness, 5_000);
`;

export function renderMobileShell() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#141d24">
<meta name="color-scheme" content="dark">
<link rel="manifest" href="/manifest.webmanifest">
<title>Helmian Herald</title>
<style>
:root{--bg:#071018;--panel:#101d27;--panel2:#142631;--line:#254657;--ink:#dff7ff;--muted:#83a7b8;--accent:#32c8ff;--warn:#d3a558}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
main{max-width:520px;margin:auto;padding:18px} header{display:flex;align-items:center;justify-content:space-between;margin:4px 0 20px}.brand{font-weight:750;letter-spacing:.01em}.sub{color:var(--muted);font-size:12px}
.badge{border:1px solid var(--line);border-radius:999px;padding:5px 9px;color:var(--muted);font-size:10px;font-weight:750;letter-spacing:.06em}.badge[data-tone=warn]{color:var(--warn);border-color:#5b4a2f}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:12px}.eyebrow{color:var(--muted);font-size:10px;font-weight:750;letter-spacing:.09em;text-transform:uppercase}.state{font-size:12px;font-weight:800;color:var(--warn);margin-top:14px}.headline{font-size:22px;font-weight:720;line-height:1.2;margin:5px 0 7px}.detail,.muted{color:var(--muted)}
label{display:block;color:var(--muted);font-size:12px;margin:12px 0 6px}input{width:100%;background:#0d1419;color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:12px;font:18px ui-monospace,monospace;letter-spacing:.15em}button{width:100%;margin-top:10px;border:1px solid #46545e;background:var(--panel2);color:var(--ink);border-radius:10px;padding:11px;font-weight:700}button:active{transform:translateY(1px)}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.metric{background:var(--panel2);border-radius:10px;padding:11px}.metric strong{display:block;font-size:18px}.metric span{color:var(--muted);font-size:10px}.boundary{font-size:12px;color:var(--muted)}.boundary strong{color:var(--ink)}.context{display:grid;grid-template-columns:1fr 1fr;gap:9px}.context div{background:var(--panel2);border-radius:10px;padding:10px}.context span{display:block;color:var(--muted);font-size:10px}.output{border-left:2px solid var(--line);padding:7px 9px;margin-top:7px;color:var(--muted)}.approval{border:1px solid var(--line);border-radius:12px;padding:11px;margin-top:8px;background:#0b1720}.approval button{width:auto;margin-right:6px}textarea{width:100%;min-height:110px;resize:vertical;background:#09151d;color:var(--ink);border:1px solid var(--line);border-radius:12px;padding:12px;font:15px/1.45 inherit}button.secondary{background:transparent}.review{border:1px solid var(--line);background:#09151d;border-radius:10px;padding:10px;margin-top:10px;white-space:pre-wrap}button:disabled{opacity:.48;cursor:not-allowed}[hidden]{display:none!important}
</style></head><body><main>
<header><div><div class="brand">Helmian Herald</div><div class="sub">Paired desktop companion</div></div><div id="connection" class="badge" data-tone="warn">CONNECTING</div></header>

<section id="pairing" class="card">
  <div class="eyebrow">Pair this phone</div>
  <div class="headline">Pair with your desktop</div>
  <p class="detail">Enter the short-lived code shown by Helmian Desktop. The desktop decides this device’s scopes and can revoke them. Herald never exposes a shell, file browser, installer, provider credential, or hidden action path.</p>
  <label for="pair-code">Pairing code</label><input id="pair-code" inputmode="numeric" autocomplete="one-time-code" maxlength="8">
  <button id="pair-button">Pair with Helmian Desktop</button><p id="pair-message" class="muted" aria-live="polite"></p>
</section>

<section id="status" hidden>
  <div class="card"><div class="eyebrow">Local Helmian digest</div><div id="state" class="state">UNKNOWN</div><div id="headline" class="headline"></div><div id="detail" class="detail"></div><button id="refresh-button">Refresh status</button></div>
  <div class="metrics"><div class="metric"><strong id="lease">—</strong><span>LEASE</span></div><div class="metric"><strong id="refusals">—</strong><span>REFUSALS</span></div><div class="metric"><strong id="blocks">—</strong><span>BLOCKS</span></div></div>
  <p class="muted">Generated <span id="generated">unknown</span></p>
</section>

<section id="session-card" class="card" hidden>
  <div class="eyebrow">Active Helmian work</div>
  <div class="context">
    <div><span>PROJECT</span><strong id="project-name">—</strong></div>
    <div><span>SESSION</span><strong id="session-name">—</strong></div>
    <div><span>AGENT</span><strong id="agent-name">—</strong></div>
    <div><span>GUARD</span><strong id="guard-state">unknown</strong></div>
  </div>
  <div class="eyebrow" style="margin-top:16px">Recent outputs</div><div id="outputs"></div>
  <div class="eyebrow" style="margin-top:16px">Approvals waiting on you</div><div id="approvals"></div>
  <div id="approval-confirm" hidden>
    <div id="approval-preview" class="review"></div>
    <button id="send-approval">Confirm this decision</button>
    <button id="cancel-approval" class="secondary">Cancel</button>
  </div>
  <p id="approval-state" class="muted" aria-live="polite">No decision is applied until you review and confirm.</p>
  <label for="instruction">Instruction for the selected session</label>
  <textarea id="instruction" maxlength="2800" placeholder="Write an instruction for the active Helmian session"></textarea>
  <button id="review-instruction">Review before sending</button>
  <div id="instruction-confirm" hidden>
    <div id="instruction-preview" class="review"></div>
    <button id="send-instruction">Send this instruction</button>
    <button id="cancel-instruction" class="secondary">Cancel</button>
  </div>
  <p id="instruction-state" class="muted" aria-live="polite">Nothing is sent until you review and confirm.</p>
  <div class="eyebrow" style="margin-top:18px">Voice</div>
  <button id="voice-button" disabled>Start voice input</button>
  <p id="voice-state" class="muted">Voice availability is owned by the connected desktop session.</p>
</section>

<section class="card boundary"><strong>Companion boundary</strong><br>Offline and stale states never look healthy. Instructions and approval decisions are paired, project/session-scoped, audited by the desktop, and denied when Helmian Desktop is unavailable. There is no cloud relay, public proxy, generic terminal, file browser, installer, or direct provider credential handling.</section>
</main><script src="/app.js" defer></script></body></html>`;
}
