const signedOut = document.querySelector('#signed-out');
const signedIn = document.querySelector('#signed-in');
const actor = document.querySelector('#actor');
const out = document.querySelector('#result');
const policyActions = document.querySelector('#policy-actions');
const policyForm = document.querySelector('#policy-form');
const policyConfirmation = document.querySelector('#policy-confirmation');
const policyDiff = document.querySelector('#policy-diff');
const policyStatus = document.querySelector('#policy-status');
const scope = document.querySelector('#scope');
let policyEtag = '';
let previewId = '';
document.querySelector('#login').onclick = () => { window.location.href = '/admin/auth/login'; };
document.querySelector('#logout').onclick = () => { window.location.href = '/admin/auth/logout'; };

function renderPolicy(body) {
  policyActions.replaceChildren();
  for (const name of body.allowedActions) {
    const label = document.createElement('label');
    label.className = 'tool';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'enabledAction';
    checkbox.value = name;
    checkbox.checked = body.policy.enabledActions.includes(name);
    label.append(checkbox, ` ${name}`);
    policyActions.append(label);
  }
  policyStatus.textContent = `Global policy version ${body.policy.version} (${body.policy.source}). Changes apply to all newly signed AimForge customer sessions.`;
  previewId = '';
  policyConfirmation.hidden = true;
}

async function loadPolicy() {
  const response = await fetch('/api/admin/action-policy', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Action policy unavailable');
  policyEtag = response.headers.get('etag') ?? '';
  renderPolicy(await response.json());
}

async function load() {
  const session = await fetch('/api/admin/session', { credentials: 'same-origin' });
  if (!session.ok) { signedOut.hidden = false; signedIn.hidden = true; return; }
  const sessionBody = await session.json();
  signedOut.hidden = true; signedIn.hidden = false;
  actor.textContent = `Signed in as ${sessionBody.actor.role} for tenant ${sessionBody.actor.tenantId}`;
  scope.textContent = `Scope: ${sessionBody.actor.tenantId} · ${sessionBody.actor.role}`;
  const surface = await fetch('/api/admin/control-surface', { credentials: 'same-origin' });
  out.textContent = JSON.stringify(await surface.json(), null, 2);
  await loadPolicy();
}
document.querySelector('#refresh').onclick = () => load().catch(() => { out.textContent = 'Control surface unavailable.'; });
policyForm.onsubmit = async (event) => {
  event.preventDefault();
  policyStatus.textContent = 'Creating audited preview…';
  const enabledActions = [...document.querySelectorAll('input[name="enabledAction"]:checked')].map((input) => input.value);
  const response = await fetch('/api/admin/action-policy/preview', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'if-match': policyEtag },
    body: JSON.stringify({ enabledActions }),
  });
  const body = await response.json();
  if (!response.ok) { policyStatus.textContent = `Preview refused: ${body.code}`; return; }
  previewId = body.preview.previewId;
  policyDiff.textContent = JSON.stringify({
    enabledBefore: body.preview.from,
    enabledAfter: body.preview.to,
    effect: body.preview.effect,
    scope: body.preview.scope,
  }, null, 2);
  policyConfirmation.hidden = false;
  policyStatus.textContent = 'Review the exact action list, then confirm or cancel.';
};
document.querySelector('#cancel').onclick = () => {
  previewId = '';
  policyConfirmation.hidden = true;
  policyStatus.textContent = 'Preview cancelled. No setting changed.';
};
document.querySelector('#confirm').onclick = async () => {
  if (!previewId) return;
  policyStatus.textContent = 'Confirming audited change…';
  const response = await fetch('/api/admin/action-policy/confirm', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'if-match': policyEtag },
    body: JSON.stringify({ previewId }),
  });
  const body = await response.json();
  if (!response.ok) { policyStatus.textContent = `Change refused: ${body.code}`; previewId = ''; return; }
  policyEtag = response.headers.get('etag') ?? '';
  await loadPolicy();
  policyStatus.textContent = `Global policy version ${body.policy.version} saved. It applies to all newly signed AimForge customer sessions; active sessions are unchanged.`;
};
load().catch(() => { signedOut.hidden = false; signedIn.hidden = true; });
