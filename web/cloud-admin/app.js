import { createEnvoyClient } from './envoy-client.mjs';
import { agentTaskPanelModel, artifactExecutionPanelModel, artifactScriptPanelModel, artifactSourcePanelModel, artifactStudioPanelModel, createCoraConfigClient, knowledgeQueryModel, personalPreferencesModel, usagePanelModel, workspaceLayoutModel, workspacePreviewPanelModel } from './cora-config-client.mjs';

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
const coraKnowledgeQuery = document.querySelector('#cora-knowledge-query');
const coraKnowledgeQuerySubmit = document.querySelector('#cora-knowledge-query-submit');
const coraKnowledgeQueryStatus = document.querySelector('#cora-knowledge-query-status');
const coraKnowledgeQueryResults = document.querySelector('#cora-knowledge-query-results');
const coraUsageStatus = document.querySelector('#cora-usage-status');
const coraUsageDetails = document.querySelector('#cora-usage-details');
const coraPreferencesForm = document.querySelector('#cora-personal-preferences-form');
const coraPreferencesStatus = document.querySelector('#cora-personal-preferences-status');
const coraPreferenceMuted = document.querySelector('#cora-preference-muted');
const coraPreferenceVolume = document.querySelector('#cora-preference-volume');
const coraPreferenceVerbosity = document.querySelector('#cora-preference-verbosity');
const coraPreferenceInterrupt = document.querySelector('#cora-preference-interrupt');
const coraPreferenceTurn = document.querySelector('#cora-preference-turn');
const coraPreferenceVoice = document.querySelector('#cora-preference-voice');
const coraAdminControls = document.querySelector('#cora-admin-controls');
const coraDraftReason = document.querySelector('#cora-draft-reason');
const coraRoutingPolicy = document.querySelector('#cora-routing-policy');
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
const artifactStudioForm = document.querySelector('#artifact-studio-form');
const artifactStudioType = document.querySelector('#artifact-studio-type');
const artifactStudioStage = document.querySelector('#artifact-studio-stage');
const artifactStudioTitle = document.querySelector('#artifact-studio-title');
const artifactStudioDepartment = document.querySelector('#artifact-studio-department');
const artifactStudioObjective = document.querySelector('#artifact-studio-objective');
const artifactStudioSources = document.querySelector('#artifact-studio-sources');
const artifactStudioSubmit = document.querySelector('#artifact-studio-submit');
const artifactStudioStatus = document.querySelector('#artifact-studio-status');
const artifactStudioReceipts = document.querySelector('#artifact-studio-receipts');
const artifactSourceDetails = document.querySelector('#artifact-source-details');
const artifactScriptForm = document.querySelector('#artifact-script-form');
const artifactScriptReceipt = document.querySelector('#artifact-script-receipt');
const artifactScriptText = document.querySelector('#artifact-script-text');
const artifactScriptSources = document.querySelector('#artifact-script-sources');
const artifactScriptStage = document.querySelector('#artifact-script-stage');
const artifactScriptStatus = document.querySelector('#artifact-script-status');
const artifactScriptReceipts = document.querySelector('#artifact-script-receipts');
const artifactExecutionForm = document.querySelector('#artifact-execution-form');
const artifactExecutionReceipt = document.querySelector('#artifact-execution-receipt');
const artifactExecutionScript = document.querySelector('#artifact-execution-script');
const artifactExecutionSources = document.querySelector('#artifact-execution-sources');
const artifactExecutionCatalog = document.querySelector('#artifact-execution-catalog');
const artifactExecutionProvider = document.querySelector('#artifact-execution-provider');
const artifactExecutionModel = document.querySelector('#artifact-execution-model');
const artifactExecutionModality = document.querySelector('#artifact-execution-modality');
const artifactExecutionCost = document.querySelector('#artifact-execution-cost');
const artifactExecutionStatus = document.querySelector('#artifact-execution-status');
const artifactExecutionReceipts = document.querySelector('#artifact-execution-receipts');
const workspaceState = document.querySelector('#workspace-state');
const adminNav = document.querySelector('[data-admin-only]');
const workspaceSettings = document.querySelector('#workspace-settings');
const workspaceSettingsOpen = document.querySelector('#workspace-settings-open');
const workspaceSettingsClose = document.querySelector('#workspace-settings-close');
const workspaceLayoutStatus = document.querySelector('#workspace-layout-status');
const workspaceLayoutSave = document.querySelector('#workspace-layout-save');
const workspaceLayoutReset = document.querySelector('#workspace-layout-reset');
const workspacePanelOrder = document.querySelector('#workspace-panel-order');
const workspaceDensity = document.querySelector('#workspace-density');
const workspaceDefaultChannel = document.querySelector('#workspace-default-channel');
let coraDraft = null;
let coraPublishedConfig = null;
let policyEtag = '';
let previewId = '';
let workspaceTimer = null;
let envoyTimer = null;
let envoyStream = null;
let envoyMessages = [];
let envoyCursor = null;
let workspaceLayout = null;
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
    status.textContent = agent.lastAction ? `${agent.status} · ${agent.lastAction}` : 'No audited status';
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
  workspaceDefaultChannel.replaceChildren(new Option('No default channel', ''));
  for (const channel of body.channels ?? []) {
    const option = document.createElement('option');
    option.value = channel.id;
    option.textContent = channel.title || channel.slug;
    envoyChannel.append(option);
    const layoutOption = option.cloneNode(true);
    workspaceDefaultChannel.append(layoutOption);
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

function renderWorkspaceLayout(body) {
  const model = workspaceLayoutModel(body);
  workspaceLayout = model.layout;
  for (const checkbox of document.querySelectorAll('[data-layout-shelf]')) checkbox.checked = model.layout.visibleShelves?.includes(checkbox.dataset.layoutShelf) ?? false;
  workspacePanelOrder.value = (model.layout.panelOrder ?? []).join(',');
  workspaceDensity.value = model.layout.density ?? 'comfortable';
  workspaceDefaultChannel.value = model.layout.defaultEnvoyChannelId ?? '';
  workspaceLayoutStatus.textContent = model.statusLabel;
}

async function loadWorkspaceLayout() {
  workspaceLayoutStatus.textContent = 'Loading your workspace layout…';
  workspaceSettings.setAttribute('aria-busy', 'true');
  try { renderWorkspaceLayout(await coraClient.readWorkspaceLayout()); }
  catch (error) { workspaceLayoutStatus.textContent = error.status === 403 ? 'Workspace layout unavailable: Organization membership is required.' : `Workspace layout unavailable: ${error.message}`; }
  finally { workspaceSettings.removeAttribute('aria-busy'); }
}

function layoutInput() {
  return { visibleShelves: [...document.querySelectorAll('[data-layout-shelf]:checked')].map((item) => item.dataset.layoutShelf), panelOrder: workspacePanelOrder.value.split(',').map((item) => item.trim()).filter(Boolean), density: workspaceDensity.value, defaultEnvoyChannelId: workspaceDefaultChannel.value || null };
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
    if (!envoyStream) composerStatus.textContent = body.messages?.length ? 'New messages loaded.' : 'Envoy connected; no new messages.';
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      envoyStream?.close(); envoyStream = null;
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

function startEnvoyRealtime() {
  envoyStream?.close(); envoyStream = null;
  if (!envoyChannel.value) return;
  try {
    envoyStream = envoy.openMessageStream(envoyChannel.value, {
      afterId: envoyCursor,
      onOpen: () => { composerStatus.textContent = 'Envoy realtime connected; polling fallback ready.'; },
      onStatus: (status, detail) => {
        if (status === 'connected') {
          if (envoyTimer) window.clearInterval(envoyTimer);
          envoyTimer = null;
          composerStatus.textContent = 'Envoy realtime connected.';
        } else if (status === 'stale') {
          composerStatus.textContent = 'Envoy realtime is stale; reconnecting…';
        } else if (status === 'reconnecting') {
          startEnvoyPolling();
          composerStatus.textContent = `Envoy reconnecting (attempt ${detail.attempt}); cursor polling fallback active.`;
        } else if (status === 'revoked') {
          composerStatus.textContent = 'Envoy membership was revoked. Sign in again.';
        }
      },
      onMessage: (message) => {
        if (!envoyMessages.some((item) => item.id === message.id)) envoyMessages.push(message);
        envoyCursor = message.id;
        renderMessageList();
        composerStatus.textContent = 'New Envoy message received.';
      },
      onError: (error) => {
        envoyStream?.close(); envoyStream = null;
        startEnvoyPolling();
        composerStatus.textContent = error.status === 403 ? 'Envoy membership was revoked. Sign in again.' : 'Realtime unavailable; cursor polling fallback active.';
      },
    });
    if (!envoyStream) throw new Error('Envoy realtime is unavailable');
    if (envoyTimer) window.clearInterval(envoyTimer);
    envoyTimer = null;
  } catch (error) {
    startEnvoyPolling();
    composerStatus.textContent = `Realtime unavailable; cursor polling fallback active: ${error.message}`;
  }
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
  const policy = config.config?.routingPolicy;
  coraConfigDetails.append(configItem('Routing policy', policy ? `v${policy.version} · ${policy.entries?.length ?? 0} task classes · provider calls remain disconnected` : 'Not published'));
  coraPublishedConfig = config.config;
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

function renderCoraKnowledgeQuery(body) {
  const model = knowledgeQueryModel(body); coraKnowledgeQueryResults.replaceChildren();
  if (model.empty) { coraKnowledgeQueryStatus.textContent = 'No approved, effective, nonexpired source matched. No answer was generated.'; return; }
  coraKnowledgeQueryStatus.textContent = 'Stored approved source excerpts only. No legal conclusion or model answer was generated.';
  for (const entry of model.excerpts) {
    const card = document.createElement('article'); card.className = 'config-item';
    card.append(configItem('Excerpt', entry.excerpt), configItem('Citation', entry.citation), configItem('Source', `${entry.title} · ${entry.publisher}`), configItem('Provenance', `${entry.provenance} · ${entry.pack}`));
    coraKnowledgeQueryResults.append(card);
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

function renderPersonalPreferences(body) { const model = personalPreferencesModel(body); const prefs = model.preferences; coraPreferenceMuted.checked = prefs.muted === true; coraPreferenceVolume.value = prefs.volume ?? 80; coraPreferenceVerbosity.value = prefs.verbosity ?? 'concise'; coraPreferenceInterrupt.value = prefs.interruptMode ?? 'barge_in'; coraPreferenceTurn.value = prefs.turnMode ?? 'concise'; coraPreferenceVoice.value = prefs.voiceProfile ?? ''; coraPreferencesStatus.textContent = model.statusLabel; }
async function loadPersonalPreferences() { coraPreferencesStatus.textContent = 'Loading your Cora preferences…'; try { renderPersonalPreferences(await coraClient.readPersonalPreferences()); } catch (error) { coraPreferencesStatus.textContent = error.status === 403 ? 'Personal preferences unavailable: Organization membership is required.' : `Personal preferences unavailable: ${error.message}`; } }

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

function renderArtifactStudio(body) {
  const model = artifactStudioPanelModel(body);
  artifactStudioReceipts.replaceChildren();
  artifactStudioStatus.textContent = model.empty ? 'No Artifact Studio receipts yet. Drafting and source metadata are available without approval.' : model.statusLabel;
  for (const receipt of model.receipts) {
    const card = document.createElement('article'); card.className = 'config-item';
    card.append(configItem('Artifact', `${receipt.artifactType} · ${receipt.status}`), configItem('Title', receipt.title), configItem('Sources', `${receipt.sourceRefs?.length ?? 0} reference(s)`), configItem('Receipt', receipt.receiptId || 'unavailable'), configItem('Execution', 'Not performed'), configItem('Media / provider', 'Not generated / not invoked'));
    artifactStudioReceipts.append(card);
  }
}

function renderArtifactSources(body) {
  const model = artifactSourcePanelModel(body);
  artifactSourceDetails.replaceChildren();
  if (model.empty) { artifactSourceDetails.textContent = model.statusLabel; return; }
  for (const source of model.sources) { const item = document.createElement('div'); item.className = 'config-item'; item.textContent = `${source.sourceKey} · ${source.lifecycle} · ${source.classification} · ${source.title}`; artifactSourceDetails.append(item); }
  for (const link of model.links) { const item = document.createElement('div'); item.className = 'config-item'; item.textContent = `Linked ${link.sourceKey} to artifact ${link.artifactReceiptId} · immutable receipt ${link.linkReceiptId}`; artifactSourceDetails.append(item); }
}
function renderArtifactScripts(body) { const model = artifactScriptPanelModel(body); artifactScriptReceipts.replaceChildren(); artifactScriptStatus.textContent = model.statusLabel; for (const receipt of model.receipts) { const item = document.createElement('div'); item.className = 'config-item'; const meta = document.createElement('strong'); meta.textContent = `Revision ${receipt.revision} · ${receipt.stage} · ${receipt.receiptId}`; const provenance = document.createElement('span'); provenance.textContent = `${receipt.createdBySubject || 'verified member'} · ${receipt.createdAt || 'timestamp unavailable'} · prepared, not generated`; const text = document.createElement('p'); text.textContent = receipt.text || 'Manual text unavailable.'; item.append(meta, provenance, text); artifactScriptReceipts.append(item); } }
async function loadArtifactScripts(receiptId) { if (!receiptId) { artifactScriptReceipts.replaceChildren(); artifactScriptStatus.textContent = 'Enter an artifact receipt to read manual script revisions.'; return; } artifactScriptStatus.textContent = 'Loading manual script revisions…'; try { renderArtifactScripts(await coraClient.readArtifactScripts(receiptId)); } catch (error) { artifactScriptReceipts.replaceChildren(); artifactScriptStatus.textContent = error.status === 403 ? 'Script revisions unavailable: Organization membership is required.' : `Script revisions unavailable: ${error.message}`; } }
function renderArtifactExecutionRequests(body) { const model = artifactExecutionPanelModel(body); artifactExecutionReceipts.replaceChildren(); artifactExecutionStatus.textContent = model.statusLabel; for (const receipt of model.receipts) { const item = document.createElement('div'); item.className = 'config-item'; item.textContent = `${receipt.status} · ${receipt.provider}/${receipt.model} · ${receipt.modality} · ${receipt.receiptId} · execution not executed`; artifactExecutionReceipts.append(item); } }
async function loadArtifactExecutionRequests(receiptId) { if (!receiptId) { artifactExecutionReceipts.replaceChildren(); artifactExecutionStatus.textContent = 'Enter an artifact receipt to read execution request receipts.'; return; } artifactExecutionStatus.textContent = 'Loading execution request receipts…'; try { renderArtifactExecutionRequests(await coraClient.readArtifactExecutionRequests(receiptId)); } catch (error) { artifactExecutionReceipts.replaceChildren(); artifactExecutionStatus.textContent = error.status === 403 ? 'Execution requests unavailable: Organization membership is required.' : `Execution requests unavailable: ${error.message}`; } }

async function loadArtifactStudio({ replayed = false } = {}) {
  artifactStudioStatus.textContent = 'Loading Artifact Studio receipts…';
  try { const [artifacts, sources] = await Promise.all([coraClient.readArtifacts(), coraClient.readArtifactSources()]); renderArtifactStudio({ ...artifacts, replayed }); renderArtifactSources(sources); }
  catch (error) { artifactStudioReceipts.replaceChildren(); artifactSourceDetails.textContent = ''; artifactStudioStatus.textContent = error.status === 403 ? 'Artifact receipts unavailable: Organization membership is required.' : `Artifact receipts unavailable: ${error.message}`; }
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
    await loadPersonalPreferences();
    if (config.status === 'published') coraConfigStatus.textContent += ' Cora agent/model invocation remains not connected.';
  } catch (error) {
    coraConfigDetails.replaceChildren(); coraKnowledgeDetails.replaceChildren(); coraUsageDetails.replaceChildren();
    coraConfigStatus.textContent = error.status === 403 ? 'Cora settings unavailable: Organization membership is required.' : `Cora settings unavailable: ${error.message}`;
    coraUsageStatus.className = 'usage-state hard';
    coraUsageStatus.textContent = error.status === 403 ? 'Usage summary unavailable: Organization membership is required.' : `Usage summary unavailable: ${error.message}`;
  }
}

coraPreferencesForm.onsubmit = async (event) => { event.preventDefault(); coraPreferencesStatus.textContent = 'Saving your Cora preferences…'; try { await coraClient.savePersonalPreferences({ muted: coraPreferenceMuted.checked, volume: Number(coraPreferenceVolume.value), verbosity: coraPreferenceVerbosity.value, interruptMode: coraPreferenceInterrupt.value, turnMode: coraPreferenceTurn.value, voiceProfile: coraPreferenceVoice.value || null }); coraPreferencesStatus.textContent = 'Your personal Cora preferences were saved. Organization policy and catalog remain unchanged.'; } catch (error) { coraPreferencesStatus.textContent = `Personal preferences not saved: ${error.message}`; } };

async function loadPolicy() {
  const response = await fetch('/api/admin/action-policy', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Action policy unavailable');
  policyEtag = response.headers.get('etag') ?? '';
  renderPolicy(await response.json());
}

async function load() {
  const session = await fetch('/api/admin/session', { credentials: 'same-origin' });
  if (!session.ok) { signedOut.hidden = false; signedIn.hidden = true; workspaceSettingsOpen.hidden = true; return; }
  const sessionBody = await session.json();
  signedOut.hidden = true; signedIn.hidden = false;
  actor.textContent = `Signed in as ${sessionBody.actor.role} for Organization ${sessionBody.actor.tenantId}`;
  scope.textContent = `Organization scope: ${sessionBody.actor.tenantId} · ${sessionBody.actor.role}`;
  window.helmianActorRole = sessionBody.actor.role;
  const isAdmin = ['owner', 'admin'].includes(String(sessionBody.actor.role ?? '').toLowerCase());
  adminNav.hidden = !isAdmin;
  workspaceState.textContent = `AUTHENTICATED · ${String(sessionBody.actor.role ?? 'member').toUpperCase()}`;
  const surface = await fetch('/api/admin/control-surface', { credentials: 'same-origin' });
  out.textContent = JSON.stringify(await surface.json(), null, 2);
  await refreshWorkspacePanels();
  await loadPolicy();
  await loadEnvoyChannels();
  workspaceSettingsOpen.hidden = false;
  await loadWorkspaceLayout();
  await loadCoraSettings();
  await loadWorkspacePreviews();
  await loadAgentTasks();
  await loadArtifactStudio();
  startEnvoyRealtime();
  if (!workspaceTimer) workspaceTimer = window.setInterval(() => refreshWorkspacePanels().catch(() => {}), 15000);
}
workspaceSettingsOpen.onclick = () => { workspaceSettings.showModal(); loadWorkspaceLayout().catch(() => {}); };
workspaceSettingsClose.onclick = () => workspaceSettings.close();
workspaceLayoutSave.onclick = async () => { workspaceLayoutStatus.textContent = 'Saving your workspace layout…'; workspaceLayoutSave.disabled = true; try { renderWorkspaceLayout(await coraClient.saveWorkspaceLayout(layoutInput())); } catch (error) { workspaceLayoutStatus.textContent = `Workspace layout not saved: ${error.message}`; } finally { workspaceLayoutSave.disabled = false; } };
workspaceLayoutReset.onclick = async () => { workspaceLayoutStatus.textContent = 'Restoring your role default…'; workspaceLayoutReset.disabled = true; try { renderWorkspaceLayout(await coraClient.resetWorkspaceLayout()); } catch (error) { workspaceLayoutStatus.textContent = `Workspace layout not reset: ${error.message}`; } finally { workspaceLayoutReset.disabled = false; } };
for (const item of document.querySelectorAll('#workspace-nav [data-target]')) {
  item.onclick = () => {
    document.getElementById(item.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    for (const peer of document.querySelectorAll('#workspace-nav [data-target]')) { peer.classList.toggle('active', peer === item); if (peer === item) peer.setAttribute('aria-current', 'page'); else peer.removeAttribute('aria-current'); }
  };
}
document.querySelector('#refresh-workspace').onclick = () => refreshWorkspacePanels().catch(() => {});
document.querySelector('#refresh').onclick = () => load().catch(() => { out.textContent = 'Control surface unavailable.'; });
coraCreateDraft.onclick = async () => {
  const reason = coraDraftReason.value.trim();
  if (!reason) { coraConfigStatus.textContent = 'Enter a reason before creating a draft.'; return; }
  coraCreateDraft.disabled = true;
  try {
    let routingPolicy = null;
    if (coraRoutingPolicy.value.trim()) {
      try { routingPolicy = JSON.parse(coraRoutingPolicy.value); } catch { coraConfigStatus.textContent = 'Routing policy must be valid JSON.'; return; }
    }
    const result = await coraClient.createDraft({ reason, routingPolicy, approvedModelCatalog: coraPublishedConfig?.approvedModelCatalog ?? [] }); coraDraft = result.config; coraDraftReason.value = '';
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
coraKnowledgeQuerySubmit.onclick = async () => {
  const query = coraKnowledgeQuery.value.trim();
  if (!query) { coraKnowledgeQueryStatus.textContent = 'Enter a bounded knowledge query.'; return; }
  coraKnowledgeQuerySubmit.disabled = true; coraKnowledgeQueryStatus.textContent = 'Searching stored approved sources…';
  try { renderCoraKnowledgeQuery(await coraClient.queryKnowledge(query)); }
  catch (error) { coraKnowledgeQueryResults.replaceChildren(); coraKnowledgeQueryStatus.textContent = error.status === 403 ? 'Knowledge query unavailable: Organization membership is required.' : `Knowledge query unavailable: ${error.message}`; }
  finally { coraKnowledgeQuerySubmit.disabled = false; }
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
artifactStudioForm.onsubmit = async (event) => {
  event.preventDefault();
  if (!artifactStudioTitle.value.trim() || !artifactStudioObjective.value.trim()) { artifactStudioStatus.textContent = 'Enter a bounded artifact title and objective.'; return; }
  artifactStudioSubmit.disabled = true; artifactStudioStatus.textContent = 'Recording Artifact Studio receipt…';
  const sourceRefs = artifactStudioSources.value.split('\n').map((citation) => citation.trim()).filter(Boolean).map((citation) => ({ citation, title: citation }));
  try {
    const result = await coraClient.createArtifact({ artifactType: artifactStudioType.value, stage: artifactStudioStage.value, title: artifactStudioTitle.value.trim(), department: artifactStudioDepartment.value.trim() || 'general', objective: artifactStudioObjective.value.trim(), sourceRefs, idempotencyKey: crypto.randomUUID(), approvalReason: null });
    artifactStudioStatus.textContent = result.replayed ? 'Artifact intent already received. Durable replay receipt confirmed.' : 'Artifact intent recorded. No media or provider execution occurred.';
    artifactStudioTitle.value = ''; artifactStudioObjective.value = ''; artifactStudioSources.value = ''; await loadArtifactStudio({ replayed: result.replayed === true });
  } catch (error) { artifactStudioStatus.textContent = `Artifact intent not recorded: ${error.message}`; }
  finally { artifactStudioSubmit.disabled = false; }
};
artifactScriptForm.onsubmit = async (event) => { event.preventDefault(); if (!artifactScriptReceipt.value.trim() || !artifactScriptText.value.trim()) { artifactScriptStatus.textContent = 'Enter an artifact receipt and bounded manual script text.'; return; } artifactScriptStatus.textContent = 'Recording manual script revision…'; try { const sourceLinkReceiptIds = artifactScriptSources.value.split('\n').map((value) => value.trim()).filter(Boolean); const result = await coraClient.createArtifactScript({ artifactReceiptId: artifactScriptReceipt.value.trim(), scriptKind: 'narration', text: artifactScriptText.value.trim(), sourceLinkReceiptIds, stage: artifactScriptStage.value, approvalReason: null, idempotencyKey: crypto.randomUUID() }); artifactScriptText.value = ''; artifactScriptStatus.textContent = result.replayed ? 'Script revision replay receipt confirmed.' : 'Manual script revision prepared. No generation occurred.'; await loadArtifactScripts(artifactScriptReceipt.value.trim()); } catch (error) { artifactScriptStatus.textContent = `Script revision not recorded: ${error.message}`; } };
artifactExecutionForm.onsubmit = async (event) => { event.preventDefault(); if (!artifactExecutionReceipt.value.trim() || !artifactExecutionScript.value.trim() || !artifactExecutionSources.value.trim()) { artifactExecutionStatus.textContent = 'Enter linked artifact, source-checked script, and approved source link receipts.'; return; } artifactExecutionStatus.textContent = 'Running execution policy preflight…'; try { const result = await coraClient.createArtifactExecutionRequest({ artifactReceiptId: artifactExecutionReceipt.value.trim(), scriptReceiptId: artifactExecutionScript.value.trim(), sourceLinkReceiptIds: artifactExecutionSources.value.split('\n').map((value) => value.trim()).filter(Boolean), catalogEntryId: artifactExecutionCatalog.value.trim(), provider: artifactExecutionProvider.value.trim(), model: artifactExecutionModel.value.trim(), modality: artifactExecutionModality.value, estimatedCostMinor: artifactExecutionCost.value.trim() || null, externalExecution: true, idempotencyKey: crypto.randomUUID() }); artifactExecutionStatus.textContent = result.replayed ? 'Execution request replay receipt confirmed.' : result.status === 'approval_required' ? 'Approval required. Nothing was executed.' : result.status === 'blocked' ? 'Execution blocked by policy or budget. Nothing was executed.' : 'Request queued for a future worker. Nothing was executed.'; await loadArtifactExecutionRequests(artifactExecutionReceipt.value.trim()); } catch (error) { artifactExecutionStatus.textContent = `Execution request not recorded: ${error.message}`; } };
envoyChannel.onchange = async () => { envoyStream?.close(); envoyStream = null; await loadEnvoyMessages(); startEnvoyRealtime(); };
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
