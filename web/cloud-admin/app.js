import { createEnvoyClient } from './envoy-client.mjs';

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
const guardEvents = document.querySelector('#guard-events');
const agentCards = document.querySelector('#agent-cards');
const conversationBody = document.querySelector('#conversation-body');
const composer = document.querySelector('#composer');
const composerInput = document.querySelector('#composer-input');
const composerSend = document.querySelector('#composer-send');
const envoyChannel = document.querySelector('#envoy-channel');
const composerStatus = document.querySelector('#composer-status');
const envoy = createEnvoyClient();
let policyEtag = '';
let previewId = '';
let workspaceTimer = null;
let envoyTimer = null;
let envoyMessages = [];
let envoyCursor = null;
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

function renderEvents(body) {
  guardEvents.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = 'Recent Guard activity';
  guardEvents.append(heading);
  if (!body.events?.length) {
    const empty = document.createElement('p');
    empty.className = 'preview';
    empty.textContent = 'No audited events yet.';
    guardEvents.append(empty);
    return;
  }
  for (const event of body.events) {
    const card = document.createElement('div');
    card.className = `guard-card ${event.decision === 'BLOCK' || event.decision === 'DENY' ? 'critical' : event.decision === 'PAUSE_FOR_OWNER' ? 'warn' : ''}`;
    const title = document.createElement('h3');
    title.textContent = `${event.decision} · ${event.actionType}`;
    const summary = document.createElement('p');
    summary.textContent = event.summary;
    card.append(title, summary);
    guardEvents.append(card);
  }
}

function renderWorkspace(body) {
  agentCards.replaceChildren();
  for (const agent of body.workspace?.agents ?? []) {
    const card = document.createElement('div');
    card.className = 'agent-card';
    const name = document.createElement('strong');
    name.textContent = agent.label;
    const status = document.createElement('div');
    status.className = 'agent-status';
    status.textContent = `${agent.status} · ${agent.lastAction || 'no recorded action'}`;
    card.append(name, status);
    agentCards.append(card);
  }
}

function renderMessages(body) {
  envoyMessages = body.messages ?? [];
  envoyCursor = body.nextCursor ?? envoyMessages.at(-1)?.id ?? null;
  renderMessageList();
}

function renderMessageList() {
  conversationBody.replaceChildren();
  if (!envoyMessages.length) {
    const empty = document.createElement('p');
    empty.className = 'preview';
    empty.textContent = 'No messages in this Organization channel yet.';
    conversationBody.append(empty);
    return;
  }
  for (const message of envoyMessages) {
    const card = document.createElement('article');
    card.className = 'message';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = `${message.authorKind === 'human' ? 'Member' : message.authorKind} · ${message.createdAt || 'time unavailable'}`;
    const text = document.createElement('p');
    text.textContent = message.body;
    card.append(meta, text);
    conversationBody.append(card);
  }
}

async function loadEnvoyChannels() {
  const body = await envoy.listChannels();
  envoyChannel.replaceChildren();
  for (const channel of body.channels ?? []) {
    const option = document.createElement('option');
    option.value = channel.id;
    option.textContent = channel.title || channel.slug;
    envoyChannel.append(option);
  }
  envoyChannel.disabled = !(body.channels?.length);
  composerInput.disabled = !(body.channels?.length);
  composerSend.disabled = !(body.channels?.length);
  if (!body.channels?.length) {
    renderMessages({ messages: [] });
    composerStatus.textContent = 'No Envoy channels are available for this Organization.';
    return;
  }
  composerStatus.textContent = 'Organization Envoy ready. Cora and outbound delivery are not invoked.';
  await loadEnvoyMessages();
}

async function loadEnvoyMessages() {
  if (!envoyChannel.value) return;
  composerStatus.textContent = 'Loading messages…';
  try {
    renderMessages(await envoy.listMessages(envoyChannel.value));
    composerStatus.textContent = 'Messages loaded.';
  } catch (error) {
    composerStatus.textContent = `Messages unavailable: ${error.message}`;
  }
}

async function pollEnvoyMessages() {
  if (!envoyChannel.value || !envoyCursor) return;
  try {
    const body = await envoy.listMessages(envoyChannel.value, { afterId: envoyCursor });
    const seen = new Set(envoyMessages.map((message) => message.id));
    for (const message of body.messages ?? []) {
      if (!seen.has(message.id)) envoyMessages.push(message);
    }
    envoyCursor = body.nextCursor ?? envoyCursor;
    renderMessageList();
    composerStatus.textContent = body.messages?.length ? 'New messages loaded.' : 'Envoy connected; no new messages.';
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      if (envoyTimer) window.clearInterval(envoyTimer);
      envoyTimer = null;
      envoyChannel.disabled = true;
      composerInput.disabled = true;
      composerSend.disabled = true;
      composerStatus.textContent = 'Session expired or Envoy membership was revoked. Sign in again.';
      return;
    }
    composerStatus.textContent = `Envoy update unavailable: ${error.message}. Retrying…`;
  }
}

function startEnvoyPolling() {
  if (envoyTimer) window.clearInterval(envoyTimer);
  envoyTimer = window.setInterval(() => pollEnvoyMessages(), 5000);
}

async function refreshWorkspacePanels() {
  const events = await fetch('/api/admin/events', { credentials: 'same-origin' });
  if (events.ok) renderEvents(await events.json());
  const workspace = await fetch('/api/admin/workspace', { credentials: 'same-origin' });
  if (workspace.ok) renderWorkspace(await workspace.json());
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
  await refreshWorkspacePanels();
  await loadPolicy();
  await loadEnvoyChannels();
  startEnvoyPolling();
  if (!workspaceTimer) workspaceTimer = window.setInterval(() => refreshWorkspacePanels().catch(() => {}), 15000);
}
document.querySelector('#refresh-workspace').onclick = () => refreshWorkspacePanels().catch(() => {});
document.querySelector('#refresh').onclick = () => load().catch(() => { out.textContent = 'Control surface unavailable.'; });
envoyChannel.onchange = () => loadEnvoyMessages();
composer.onsubmit = async (event) => {
  event.preventDefault();
  const body = composerInput.value.trim();
  if (!envoyChannel.value || !body) return;
  composerInput.disabled = true;
  composerSend.disabled = true;
  composerStatus.textContent = 'Sending…';
  try {
    const result = await envoy.sendMessage({ channelId: envoyChannel.value, body, idempotencyKey: crypto.randomUUID() });
    composerInput.value = '';
    await loadEnvoyMessages();
    composerStatus.textContent = result.receipt?.replayed ? 'Message already received. Replay receipt confirmed.' : 'Message sent. Durable receipt confirmed; Cora was not invoked.';
  } catch (error) {
    composerStatus.textContent = `Message not sent: ${error.message}`;
  } finally {
    composerInput.disabled = false;
    composerSend.disabled = false;
  }
};
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
