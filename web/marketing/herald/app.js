import { createTurnVoiceController } from './voice.js';
import {
  ACCOUNT_IDENTITY_STATES,
  CONNECTION_STATES,
  createDeliveryTracker,
  createHeraldTransport,
  createSameOriginPollingAdapter,
  describeAccountIdentity,
  normalizeAccountIdentity,
} from './runtime.js';

const $ = (id) => document.getElementById(id);
const channel = new URLSearchParams(location.search).get('channel') ?? '';
const pending = new Map();
const deliveryStorageKey = /^herald_[A-Za-z0-9_-]{20,80}$/.test(channel)
  ? `helmian-herald-pending-v1:${channel}`
  : null;
const deliveryTracker = createDeliveryTracker({ initial: loadPendingDeliveries() });
for (const item of deliveryTracker.exportPending()) pending.set(item.requestId, item.action);
const turnVoice = createTurnVoiceController();
let snapshot = null;
let connectionState = CONNECTION_STATES.NOT_PAIRED;
let accountIdentity = normalizeAccountIdentity({ state: ACCOUNT_IDENTITY_STATES.UNCONFIGURED });
let toastTimer = null;

const transport = createHeraldTransport({
  adapter: createSameOriginPollingAdapter(),
  onBatch: handleBatch,
  onState: renderConnection,
});

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').style.display = 'block';
  toastTimer = setTimeout(() => { $('toast').style.display = 'none'; }, 3200);
}

function renderConnection(status) {
  connectionState = status.state;
  const view = {
    [CONNECTION_STATES.NOT_PAIRED]: ['NOT PAIRED', 'offline'],
    [CONNECTION_STATES.CONNECTING]: ['CONNECTING', 'warn'],
    [CONNECTION_STATES.PAIRED]: ['PAIRED', 'warn'],
    [CONNECTION_STATES.SYNCING]: ['SYNCING', 'warn'],
    [CONNECTION_STATES.LIVE]: ['LIVE', 'online'],
    [CONNECTION_STATES.RECONNECTING]: ['RECONNECTING', 'warn'],
    [CONNECTION_STATES.NETWORK_OFFLINE]: ['NETWORK OFFLINE', 'danger'],
    [CONNECTION_STATES.RELAY_UNAVAILABLE]: ['RELAY UNAVAILABLE', 'danger'],
    [CONNECTION_STATES.DESKTOP_OFFLINE]: ['DESKTOP OFFLINE', 'danger'],
    [CONNECTION_STATES.DENIED]: ['PAIRING EXPIRED', 'danger'],
  }[status.state] ?? ['UNAVAILABLE', 'danger'];
  $('presence').textContent = view[0];
  $('presence').className = `pill ${view[1]}`;
  document.body.dataset.connection = status.state;
  if (status.state === CONNECTION_STATES.DENIED) {
    pending.clear();
    deliveryTracker.clear();
    persistPendingDeliveries();
    renderDeliveries();
  }
  if ([CONNECTION_STATES.NOT_PAIRED, CONNECTION_STATES.DENIED].includes(status.state)) {
    resetRemoteSurface();
  }
  syncControls();
}

function renderRuntime(data) {
  accountIdentity = normalizeAccountIdentity(data?.identity?.account);
  $('accountIdentity').textContent = accountIdentity.state === ACCOUNT_IDENTITY_STATES.VERIFIED
    ? accountIdentity.displayName || 'Verified account'
    : accountIdentity.state === ACCOUNT_IDENTITY_STATES.SIGNED_OUT ? 'Signed out' : 'Not configured';
  $('accountDetail').textContent = describeAccountIdentity(accountIdentity);

  const device = data?.identity?.device;
  $('deviceIdentity').textContent = device?.displayName || 'Paired phone';
  $('deviceDetail').textContent = device?.expiresAt
    ? `Pairing expires ${new Date(device.expiresAt).toLocaleString()}`
    : 'Pairing expiry unavailable.';

  const runtimeTransport = data?.transport;
  $('transportMode').textContent = runtimeTransport?.realtime === true ? 'Realtime relay' : 'Secure polling';
  $('transportDetail').textContent = runtimeTransport?.realtime === true
    ? 'Server-authorized realtime transport.'
    : runtimeTransport?.realtimeAvailable === true
      ? 'Ably token service ready; realtime client activation is a later slice.'
    : 'Realtime provider not configured; no API key is present in this PWA.';
}

async function loadPublicConfiguration() {
  try {
    const response = await fetch('/api/herald-config', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('configuration unavailable');
    const config = await response.json();
    $('accountDetail').textContent = config?.accountIdentity?.configured === true
      ? 'Account verification is configured on the server.'
      : 'Account sign-in is not configured; access is desktop-pairing only.';
    $('transportMode').textContent = 'Secure polling';
    $('transportDetail').textContent = config?.transport?.ablyTokenServiceConfigured === true
      ? 'Ably token service ready; realtime client is not activated.'
      : 'Realtime token service is not configured; secure polling remains active.';
  } catch {
    $('transportDetail').textContent = 'Server capability status is unavailable; secure polling remains active.';
  }
}

function render(data) {
  snapshot = data;
  $('project').textContent = data.project?.name || 'No selected project';
  $('session').textContent = data.session?.name
    ? `${data.session.name} · ${data.session.state || 'unknown'}`
    : 'No active session';
  $('guard').textContent = data.guard?.state || 'Unknown';
  $('guardDetail').textContent = data.guard?.detail || 'No current Guard detail.';
  $('freshness').textContent = data.capturedAt
    ? `Updated ${new Date(data.capturedAt).toLocaleTimeString()}`
    : 'Updated now';

  const outputs = Array.isArray(data.outputs) ? data.outputs : [];
  $('outputs').innerHTML = outputs.length
    ? outputs.map((output) => `<article><p>${escapeHtml(output.text)}</p>${output.at ? `<span class="outputTime">${new Date(output.at).toLocaleTimeString()}</span>` : ''}</article>`).join('')
    : '<p class="empty">The live session has no reviewed desktop activity yet.</p>';
  if (outputs.length) turnVoice.speakVisibleOutput(outputs.at(-1));

  const approvals = Array.isArray(data.approvals) ? data.approvals : [];
  $('approvalsCard').hidden = false;
  $('approvals').innerHTML = approvals.length
    ? approvals.map((approval) => `<div class="approval"><p>${escapeHtml(approval.summary)}</p><div class="approvalActions"><button class="deny" data-decision="deny" data-id="${escapeHtml(approval.id)}">Deny</button><button data-decision="allow-once" data-id="${escapeHtml(approval.id)}">Allow once</button></div></div>`).join('')
    : '<p class="empty">No approval is waiting for this live session.</p>';
  syncControls();
}

function resetRemoteSurface() {
  snapshot = null;
  $('project').textContent = 'No desktop connected';
  $('session').textContent = 'Pair this phone to read a selected Helmian session.';
  $('guard').textContent = 'Unknown';
  $('guardDetail').textContent = 'No live desktop evidence is available.';
  $('freshness').textContent = 'Not synced';
  $('outputs').innerHTML = '<p class="empty">Pair a live desktop session to see source-backed activity here.</p>';
  $('approvalsCard').hidden = false;
  $('approvals').innerHTML = '<p class="empty">No approval state is available until a desktop session is live.</p>';
  $('deviceIdentity').textContent = 'Not paired';
  $('deviceDetail').textContent = 'No device session.';
}

function renderDeliveries() {
  const items = deliveryTracker.list().slice(0, 5);
  $('deliveryCard').hidden = items.length === 0;
  $('deliveries').innerHTML = items.map((item) => {
    const action = item.action === 'approval.decide' ? 'Approval decision' : 'Instruction';
    return `<article class="delivery" data-state="${escapeHtml(item.state)}"><span class="deliveryState">${escapeHtml(item.state.toUpperCase())}</span><p>${action}</p><small>${escapeHtml(item.message)}</small></article>`;
  }).join('');
  persistPendingDeliveries();
}

function loadPendingDeliveries() {
  if (!deliveryStorageKey) return [];
  try { return JSON.parse(localStorage.getItem(deliveryStorageKey) ?? '[]'); }
  catch { return []; }
}

function persistPendingDeliveries() {
  if (!deliveryStorageKey) return;
  try {
    const value = deliveryTracker.exportPending();
    if (value.length) localStorage.setItem(deliveryStorageKey, JSON.stringify(value));
    else localStorage.removeItem(deliveryStorageKey);
  } catch { /* Delivery remains correct in memory when browser storage is unavailable. */ }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function sendAction(action, payload = {}, { trackDelivery = false } = {}) {
  const request = await transport.send(action, payload);
  pending.set(request.requestId, action);
  if (trackDelivery) {
    deliveryTracker.queued(request.requestId, action);
    renderDeliveries();
  }
  return request;
}

async function requestSession() {
  if ([...pending.values()].includes('session.read')) return null;
  return sendAction('session.read');
}

async function handleBatch(data) {
  renderRuntime(data);
  for (const item of data.messages ?? []) {
    const result = item.body ?? {};
    const action = pending.get(result.requestId);
    pending.delete(result.requestId);
    if (result.state === 'ok' && result.payload?.project) render(result.payload);
    if (action && action !== 'session.read') {
      const delivery = deliveryTracker.settle(result);
      if (delivery?.state === 'delivered') toast('Helmian Desktop acknowledged the request.');
      if (delivery?.state === 'refused') toast('Helmian Desktop refused the request.');
      if (delivery?.state === 'failed') toast('Helmian Desktop reported a request error.');
    } else if (result.state !== 'ok' && result.payload?.message) {
      toast(result.payload.message);
    }
  }
  renderDeliveries();
  if (![...pending.values()].includes('session.read')) void requestSession().catch(() => {});
  return { live: Boolean(snapshot?.project?.id && snapshot?.session?.id) };
}

async function refresh() {
  try {
    await requestSession();
    await transport.pollOnce();
  } catch (error) {
    toast(error.message);
  }
}

function showWorkspace() {
  $('pairCard').hidden = true;
  $('workspace').hidden = false;
  syncControls();
}

function showPairing(message = '') {
  $('workspace').hidden = false;
  $('pairCard').hidden = false;
  $('pairMessage').textContent = message;
  syncControls();
}

async function startPairedSession() {
  showWorkspace();
  await transport.start({ requestSession: false });
}

$('pair').addEventListener('click', async () => {
  $('pair').disabled = true;
  $('pairMessage').textContent = '';
  let paired = false;
  try {
    const code = $('code').value.replace(/\D/g, '');
    const response = await fetch('/api/herald-pair', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, code, displayName: $('deviceName').value }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.message || 'Pairing failed.'), { status: response.status });
    paired = true;
    toast('Phone paired. Checking the desktop session…');
    await startPairedSession();
  } catch (error) {
    if (paired) {
      showWorkspace();
      toast(`Phone paired, but session sync failed: ${error.message}`);
    } else {
      showPairing(error.message);
    }
  } finally {
    $('pair').disabled = false;
  }
});

$('refresh').addEventListener('click', refresh);

$('voice').addEventListener('click', () => {
  if (!isLive()) { toast('Wait for a live desktop session first.'); return; }
  turnVoice.start({
    onTranscript: (text) => {
      const current = $('instruction').value.trim();
      $('instruction').value = current ? `${current} ${text}` : text;
      $('voiceState').textContent = 'Transcript added. Review or edit it before sending.';
    },
    onState: syncVoiceUi,
    onError: (message) => { $('voiceState').textContent = message; syncVoiceUi(); },
  });
  syncVoiceUi();
});

$('readReplies').addEventListener('click', () => {
  turnVoice.setReadReplies(!turnVoice.readReplies);
  syncVoiceUi();
});

$('review').addEventListener('click', () => {
  const text = $('instruction').value.trim();
  if (!isLive() || !text || !snapshot?.project?.id || !snapshot?.session?.id) {
    toast('Wait for a live desktop session and enter a message.'); return;
  }
  $('reviewText').textContent = text;
  $('reviewContext').textContent = `${snapshot.project.name} · ${snapshot.session.name}`;
  $('reviewDialog').showModal();
});

$('confirmSend').addEventListener('click', async (event) => {
  event.preventDefault();
  const text = $('instruction').value.trim();
  $('reviewDialog').close();
  try {
    await sendAction('instruction.submit', {
      projectId: snapshot.project.id,
      sessionId: snapshot.session.id,
      text,
      confirmed: true,
    }, { trackDelivery: true });
    $('instruction').value = '';
    toast('Queued securely. Waiting for Helmian Desktop acknowledgement.');
  } catch (error) { toast(error.message); }
});

$('approvals').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-decision]');
  if (!button || !snapshot || !isLive()) return;
  const label = button.dataset.decision === 'allow-once' ? 'Allow once' : 'Deny';
  if (!confirm(`${label} this visible request?`)) return;
  try {
    await sendAction('approval.decide', {
      projectId: snapshot.project.id,
      sessionId: snapshot.session.id,
      approvalId: button.dataset.id,
      decision: button.dataset.decision,
      confirmed: true,
    }, { trackDelivery: true });
    toast('Decision queued. Waiting for Helmian Desktop acknowledgement.');
  } catch (error) { toast(error.message); }
});

function isLive() {
  return connectionState === CONNECTION_STATES.LIVE;
}

function syncControls() {
  const live = isLive();
  $('voice').disabled = !turnVoice.supported || !live;
  $('review').disabled = !live;
  $('instruction').disabled = !live;
  $('instruction').placeholder = live
    ? 'Type, paste, or dictate an instruction for the selected session…'
    : 'Pair a live desktop session before composing an instruction…';
  $('refresh').disabled = !$('pairCard').hidden;
  for (const button of $('approvals').querySelectorAll('button')) button.disabled = !live;
  syncVoiceUi();
}

function syncVoiceUi() {
  const voice = $('voice');
  voice.textContent = !turnVoice.supported
    ? 'Voice unavailable'
    : !isLive()
      ? 'Voice unavailable until live'
      : turnVoice.listening ? 'Stop listening' : 'Start voice input';
  voice.setAttribute('aria-pressed', String(turnVoice.listening));
  const replies = $('readReplies');
  replies.textContent = `Read visible replies: ${turnVoice.readReplies ? 'On' : 'Off'}`;
  replies.setAttribute('aria-pressed', String(turnVoice.readReplies));
  if (!turnVoice.supported) {
    $('voiceState').textContent = 'This browser does not provide speech recognition. Typing and copy/paste still work.';
  } else if (!isLive()) {
    $('voiceState').textContent = 'Voice input is unavailable until a selected desktop session is live.';
  } else if (!turnVoice.listening && !$('voiceState').textContent.includes('Transcript')) {
    $('voiceState').textContent = 'Tap once to dictate editable text. Nothing is sent until you review it.';
  }
}

async function resumePairedSession() {
  if (!channel) {
    showPairing('Open the pairing link shown by Helmian Desktop.');
    return;
  }
  $('pairMessage').textContent = 'Checking for an existing paired session…';
  try {
    await startPairedSession();
  } catch (error) {
    if (error?.status === 401) {
      transport.stop();
      showPairing('Enter the current pairing code shown by Helmian Desktop.');
      return;
    }
    if (error?.status === 503 || error?.code === 'desktop_offline') {
      showWorkspace();
      toast('This phone is paired, but Helmian Desktop is offline or stale.');
      return;
    }
    showPairing(navigator.onLine === false
      ? 'Network offline. An existing pairing could not be verified.'
      : 'The Herald relay is unavailable. An existing pairing could not be verified.');
  }
}

syncVoiceUi();
$('pair').disabled = !channel;
addEventListener('offline', () => transport.setNetworkAvailable(false));
addEventListener('online', () => transport.setNetworkAvailable(true));
if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/herald/sw.js', { scope: '/herald/' }).catch(() => {}));
}
void loadPublicConfiguration();
void resumePairedSession();
