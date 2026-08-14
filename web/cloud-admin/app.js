import { createEnvoyClient } from './envoy-client.mjs';
import { agentTaskPanelModel, createCoraConfigClient, usagePanelModel, workspacePreviewPanelModel } from './cora-config-client.mjs';

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
const coraClient = createCoraConfigClient();
const coraConfigStatus = document.querySelector('#cora-config-status');
const coraConfigDetails = document.querySelector('#cora-config-details');
const coraKnowledgeDetails = document.querySelector('#cora-knowledge-details');
const coraUsageStatus = document.querySelector('#cora-usage-status');
const coraUsageDetails = document.querySelector('#cora-usage-details');
const coraAdminControls = document.querySelector('#cora-admin-controls');
const coraDraftReason = document.querySelector('#cora-draft-reason');
const coraCreateDraft = document.querySelector('#cora-create-draft');
const coraTransition = document.querySelector('#cora-transition');
const workspacePreviewForm = document.querySelector('#workspace-preview-form');
const workspacePreviewMode = document.querySelector('#workspace-preview-mode');
const workspacePreviewIntent = document.querySelector('#workspace-preview-intent');
const workspacePreviewDepartment = document.querySelector('#workspace-preview-department');
const workspacePreviewTemplate = document.querySelector('#workspace-preview-template');
const workspacePreviewTitle = document.querySelector('#workspace-preview-title');
const workspacePreviewSubmit = document.querySelector('#workspace-preview-submit');
const workspacePreviewStatus = document.querySelector('#workspace-preview-status');
const workspacePreviewReceipts = document.querySelector('#workspace-preview-receipts');
const agentTaskForm = document.querySelector('#agent-task-form');
const agentTaskType = document.querySelector('#agent-task-type');
const agentTaskIntent = document.querySelector('#agent-task-intent');
const agentTaskGoal = document.querySelector('#agent-task-goal');
const agentTaskContext = document.querySelector('#agent-task-context');
const agentTaskDepartment = document.querySelector('#agent-task-department');
const agentTaskCostCenter = document.querySelector('#agent-task-cost-center');
const agentTaskSubmit = document.querySelector('#agent-task-submit');
const agentTaskStatus = document.querySelector('#agent-task-status');
const agentTaskReceipts = document.querySelector('#agent-task-receipts');
let coraDraft = null;
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

function configItem(label, value) {
  const item = document.createElement('div'); item.className = 'config-item';
  const strong = document.createElement('strong'); strong.textContent = label;
  const span = document.createElement('span'); span.textContent = value;
  item.append(strong, span); return item;
}

function renderCoraConfig(body) {
  coraConfigDetails.replaceChildren();
  if (body.status !== 'published' || !body.config) {
    coraConfigStatus.textContent = 'No published Cora Organization config is available.';
    return;
  }
  const config = body.config;
  const effective = config.config?.effective ?? config.config ?? {};
  coraConfigStatus.textContent = `Published config v${config.configVersion} · ${config.lifecycle} · reviewed reason: ${config.reason}`;
  coraConfigDetails.append(
    configItem('Style', effective.style || 'professional_brief'),
    configItem('Voice budget', `${effective.maxSpokenChars || 'not set'} characters`),
    configItem('Interrupt behavior', effective.interruptMode || 'not set'),
    configItem('Turn behavior', effective.turnMode || 'not set'),
    configItem('Hume voice', 'process-env readiness only'),
    configItem('Model invocation', 'not connected'),
  );
  for (const entry of config.config?.approvedModelCatalog ?? []) {
    coraConfigDetails.append(configItem(`Approved model · ${entry.provider}`, `${entry.model} ${entry.version} · ${entry.source}`));
  }
}

function renderCoraKnowledge(body) {
  coraKnowledgeDetails.replaceChildren();
  if (!body.sources?.length) { coraKnowledgeDetails.textContent = 'No approved knowledge sources or packs are published for this Organization.'; return; }
  for (const source of body.sources) {
    const line = document.createElement('p');
    const pack = source.pack ? ` · pack ${source.pack.key} v${source.pack.version} (${source.pack.allowlisted ? 'allowlisted' : 'not allowlisted'})` : '';
    const citation = source.snippet ? ` · citation ${source.snippet.citation}` : '';
    line.textContent = `${source.title} · ${source.publisher} · ${source.lifecycle}${pack}${citation}`;
    coraKnowledgeDetails.append(line);
  }
}

function renderCoraUsage(body) {
  coraUsageDetails.replaceChildren();
  const model = usagePanelModel(body);
  coraUsageStatus.className = `usage-state ${model.state}`;
  if (model.empty) {
    coraUsageStatus.textContent = 'No internal provider usage has been recorded for this Organization.';
    return;
  }
  coraUsageStatus.textContent = model.stateLabel;
  coraUsageDetails.append(
    configItem('Recorded usage events', String(model.eventCount)),
    configItem('Estimated ledger cost', model.estimatedCostMinor == null ? 'Unavailable' : String(model.estimatedCostMinor)),
    configItem('Reconciled provider cost', model.reconciledCostMinor == null ? 'Unavailable — no trusted reconciliation recorded' : String(model.reconciledCostMinor)),
    configItem('Provider calls', model.providerCalls === 'not_performed' ? 'Not performed by this panel' : model.providerCalls),
    configItem('Ledger source', 'Organization-scoped append-only internal ledger'),
  );
}

function renderWorkspacePreviews(body) {
  const model = workspacePreviewPanelModel(body);
  workspacePreviewReceipts.replaceChildren();
  if (model.empty) {
    const empty = document.createElement('p'); empty.className = 'preview';
    empty.textContent = 'No workspace preview intents recorded for this Organization.';
    workspacePreviewReceipts.append(empty);
    workspacePreviewStatus.textContent = 'No preview receipts yet. Drafting and preparing are available without an approval step.';
    return;
  }
  workspacePreviewStatus.textContent = model.statusLabel;
  for (const receipt of model.receipts) {
    const card = document.createElement('article'); card.className = 'config-item';
    card.append(
      configItem('Intent', `${receipt.intent} · ${receipt.mode}`),
      configItem('Title', receipt.title || 'Untitled preview intent'),
      configItem('Receipt', receipt.receiptId || receipt.id || 'unavailable'),
      configItem('Execution', 'Not performed'),
      configItem('Agents / providers', 'Not invoked'),
      configItem('Filesystem / build', 'Not performed'),
    );
    workspacePreviewReceipts.append(card);
  }
}

async function loadWorkspacePreviews({ replayed = false } = {}) {
  workspacePreviewStatus.textContent = 'Loading preview receipts…';
  try { renderWorkspacePreviews({ ...(await coraClient.readWorkspacePreviews()), replayed }); }
  catch (error) {
    workspacePreviewReceipts.replaceChildren();
    workspacePreviewStatus.textContent = error.status === 403 ? 'Preview receipts unavailable: Organization membership is required.' : `Preview receipts unavailable: ${error.message}`;
  }
}

function renderAgentTasks(body) {
  const model = agentTaskPanelModel(body); agentTaskReceipts.replaceChildren();
  if (model.empty) { const empty = document.createElement('p'); empty.className = 'preview'; empty.textContent = 'No agent task intents recorded for this Organization.'; agentTaskReceipts.append(empty); agentTaskStatus.textContent = 'No task intents yet. Drafting and preparing do not invoke a worker.'; return; }
  agentTaskStatus.textContent = model.statusLabel;
  for (const receipt of model.receipts) {
    const card = document.createElement('article'); card.className = 'config-item';
    card.append(configItem('Task', `${receipt.taskType} · ${receipt.status}`), configItem('Goal', receipt.goal), configItem('Receipt', receipt.receiptId || 'unavailable'), configItem('Execution', 'Not performed'), configItem('Agent / provider', 'Not invoked'), configItem('Filesystem', 'Not performed'));
    agentTaskReceipts.append(card);
  }
}

async function loadAgentTasks({ replayed = false } = {}) {
  agentTaskStatus.textContent = 'Loading task receipts…';
  try { renderAgentTasks({ ...(await coraClient.readAgentTasks()), replayed }); }
  catch (error) { agentTaskReceipts.replaceChildren(); agentTaskStatus.textContent = error.status === 403 ? 'Task receipts unavailable: Organization membership is required.' : `Task receipts unavailable: ${error.message}`; }
}

function renderCoraAdminControls() {
  coraAdminControls.hidden = !['owner', 'admin'].includes(String(window.helmianActorRole ?? '').toLowerCase());
  if (!coraDraft) { coraTransition.hidden = true; return; }
  const next = { draft: 'testing', testing: 'approved', approved: 'published' }[coraDraft.lifecycle];
  coraTransition.hidden = !next;
  coraTransition.textContent = next ? `Move draft to ${next}` : 'No further transition';
}

async function loadCoraSettings() {
  coraConfigStatus.textContent = 'Loading Cora settings and knowledge metadata…';
  coraUsageStatus.className = 'usage-state normal';
  coraUsageStatus.textContent = 'Loading internal usage summary…';
  try {
    const [config, knowledge, usage] = await Promise.all([coraClient.readConfig(), coraClient.readKnowledgeSources(), coraClient.readUsage()]);
    renderCoraConfig(config); renderCoraKnowledge(knowledge); renderCoraUsage(usage); renderCoraAdminControls();
    if (config.status === 'published') coraConfigStatus.textContent += ' Cora agent/model invocation remains not connected.';
  } catch (error) {
    coraConfigDetails.replaceChildren(); coraKnowledgeDetails.replaceChildren(); coraUsageDetails.replaceChildren();
    coraConfigStatus.textContent = error.status === 403 ? 'Cora settings unavailable: Organization membership is required.' : `Cora settings unavailable: ${error.message}`;
    coraUsageStatus.className = 'usage-state hard';
    coraUsageStatus.textContent = error.status === 403 ? 'Usage summary unavailable: Organization membership is required.' : `Usage summary unavailable: ${error.message}`;
  }
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
  window.helmianActorRole = sessionBody.actor.role;
  const surface = await fetch('/api/admin/control-surface', { credentials: 'same-origin' });
  out.textContent = JSON.stringify(await surface.json(), null, 2);
  await refreshWorkspacePanels();
  await loadPolicy();
  await loadEnvoyChannels();
  await loadCoraSettings();
  await loadWorkspacePreviews();
  await loadAgentTasks();
  startEnvoyPolling();
  if (!workspaceTimer) workspaceTimer = window.setInterval(() => refreshWorkspacePanels().catch(() => {}), 15000);
}
document.querySelector('#refresh-workspace').onclick = () => refreshWorkspacePanels().catch(() => {});
document.querySelector('#refresh').onclick = () => load().catch(() => { out.textContent = 'Control surface unavailable.'; });
coraCreateDraft.onclick = async () => {
  const reason = coraDraftReason.value.trim();
  if (!reason) { coraConfigStatus.textContent = 'Enter a reason before creating a draft.'; return; }
  coraCreateDraft.disabled = true;
  try {
    const result = await coraClient.createDraft({ reason }); coraDraft = result.config; coraDraftReason.value = '';
    coraConfigStatus.textContent = `Draft ${coraDraft.id} created. No config is published.`; renderCoraAdminControls();
  } catch (error) { coraConfigStatus.textContent = `Draft refused: ${error.message}`; }
  finally { coraCreateDraft.disabled = false; }
};
coraTransition.onclick = async () => {
  const next = { draft: 'testing', testing: 'approved', approved: 'published' }[coraDraft?.lifecycle];
  if (!coraDraft || !next) return;
  coraTransition.disabled = true;
  try {
    const result = await coraClient.transition({ id: coraDraft.id, lifecycle: next, reason: `Cloud admin reviewed transition to ${next}` });
    coraDraft.lifecycle = result.lifecycle;
    coraConfigStatus.textContent = `Draft ${coraDraft.id} is now ${result.lifecycle}.`;
    renderCoraAdminControls();
    await loadCoraSettings();
  } catch (error) { coraConfigStatus.textContent = `Transition refused: ${error.message}`; }
  finally { coraTransition.disabled = false; }
};
workspacePreviewForm.onsubmit = async (event) => {
  event.preventDefault();
  if (!workspacePreviewTitle.value.trim()) { workspacePreviewStatus.textContent = 'Enter a bounded preview title.'; return; }
  workspacePreviewSubmit.disabled = true;
  workspacePreviewStatus.textContent = 'Preparing preview intent…';
  try {
    const result = await coraClient.createWorkspacePreview({
      mode: workspacePreviewMode.value, intent: workspacePreviewIntent.value,
      department: workspacePreviewDepartment.value.trim() || undefined,
      templateId: workspacePreviewTemplate.value.trim() || undefined,
      title: workspacePreviewTitle.value.trim(), idempotencyKey: crypto.randomUUID(),
    });
    workspacePreviewStatus.textContent = result.replayed ? 'Preview intent already received. Durable replay receipt confirmed.' : 'Preview intent prepared. Durable receipt confirmed.';
    workspacePreviewTitle.value = '';
    await loadWorkspacePreviews({ replayed: result.replayed === true });
  } catch (error) { workspacePreviewStatus.textContent = `Preview intent not prepared: ${error.message}`; }
  finally { workspacePreviewSubmit.disabled = false; }
};
agentTaskForm.onsubmit = async (event) => {
  event.preventDefault();
  if (!agentTaskGoal.value.trim()) { agentTaskStatus.textContent = 'Enter a bounded task goal.'; return; }
  agentTaskSubmit.disabled = true; agentTaskStatus.textContent = 'Recording task intent…';
  try {
    const result = await coraClient.createAgentTask({ taskType: agentTaskType.value, intent: agentTaskIntent.value, goal: agentTaskGoal.value.trim(), contextRef: agentTaskContext.value.trim() || undefined, department: agentTaskDepartment.value.trim() || undefined, costCenter: agentTaskCostCenter.value.trim() || undefined, idempotencyKey: crypto.randomUUID() });
    agentTaskGoal.value = ''; agentTaskStatus.textContent = result.replayed ? 'Task intent already received. Durable replay receipt confirmed.' : 'Task intent recorded. No worker execution occurred.'; await loadAgentTasks({ replayed: result.replayed === true });
  } catch (error) { agentTaskStatus.textContent = `Task intent not recorded: ${error.message}`; }
  finally { agentTaskSubmit.disabled = false; }
};
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
