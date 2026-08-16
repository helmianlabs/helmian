import {
  connectionRequirement,
  normalizeDrawer,
  normalizeMobilePane,
  normalizeTheme,
} from './shell-state.js';
import {
  createAblyAccountControl,
  createAccountRemoteControlApi,
  loadAblyBrowser,
  loadClerkBrowser,
} from './account-runtime.js?v=14';
import { createDeliveryTracker } from './runtime.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const workspace = $('#workspace');
const appShell = $('#appShell');
const drawer = $('#contextDrawer');
const toastNode = $('#toast');
const composer = $('#composer');
const messageInput = $('#messageInput');
const shortcutsDialog = $('#shortcutsDialog');
const accountDialog = $('#accountDialog');
const draftKey = 'helmian:pwa:draft-v1';
const themeKey = 'helmian:pwa:theme-v1';
let activeDrawer = null;
let toastTimer = null;
let clerk = null;
let remoteApi = createAccountRemoteControlApi();
let remoteTransport = null;
let selectedControl = null;
let activeAccountId = null;
const requestedAccountMode = new URLSearchParams(window.location.search).get('auth') === 'signup'
  ? 'signup'
  : 'signin';
let accountMode = requestedAccountMode;
const delivery = createDeliveryTracker();

function readStorage(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; }
  catch { return fallback; }
}

function writeStorage(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* Presentation state remains usable without browser storage. */ }
}

function showToast(message) {
  clearTimeout(toastTimer);
  toastNode.textContent = message;
  toastNode.hidden = false;
  toastTimer = setTimeout(() => { toastNode.hidden = true; }, 3600);
}

function closeMenus() {
  $$('[data-menu]').forEach((menu) => { menu.hidden = true; });
  $$('[data-menu-trigger]').forEach((trigger) => trigger.setAttribute('aria-expanded', 'false'));
}

function toggleMenu(name, trigger) {
  const menu = $(`[data-menu="${name}"]`);
  if (!menu) return;
  const willOpen = menu.hidden;
  closeMenus();
  if (willOpen) {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const first = $('button:not(:disabled)', menu);
    queueMicrotask(() => first?.focus({ preventScroll: true }));
  }
}

function setTheme(value) {
  const theme = normalizeTheme(value);
  document.documentElement.dataset.theme = theme;
  writeStorage(themeKey, theme);
  $$('[data-theme-choice]').forEach((button) => {
    button.setAttribute('aria-checked', String(button.dataset.themeChoice === theme));
  });
  const meta = $('meta[name="theme-color"]');
  if (meta) {
    const map = {
      midnight: '#0b1018',
      black: '#050505',
      white: '#f4f6f8',
      paper: '#f7f3ea',
      ocean: '#07111d',
      glass: '#08080c',
      warm: '#17100b',
      forest: '#08100f',
    };
    meta.content = map[theme] ?? '#0b1018';
  }
}

function setRailExpanded(expanded) {
  appShell.classList.toggle('rail-expanded', expanded);
  $$('[data-command="toggle-rail"]').forEach((button) => {
    const label = expanded ? 'Collapse navigation' : 'Expand navigation';
    button.setAttribute('aria-label', label);
    button.title = label;
  });
}

function openDrawer(name) {
  const next = normalizeDrawer(name);
  if (!next) return;
  closeMenus();
  const panel = $(`[data-drawer-panel="${next}"]`);
  if (!panel) return;
  $$('[data-drawer-panel]').forEach((item) => { item.hidden = item !== panel; });
  $('#drawerTitle').textContent = panel.dataset.title;
  $('#drawerEyebrow').textContent = panel.dataset.eyebrow;
  workspace.classList.add('drawer-open');
  drawer.setAttribute('aria-hidden', 'false');
  activeDrawer = next;
  $$('.rail-item').forEach((button) => button.classList.remove('active'));
  $$('[data-open-drawer]').forEach((button) => button.classList.toggle('active', button.dataset.openDrawer === next));
}

function closeDrawer() {
  workspace.classList.remove('drawer-open');
  drawer.setAttribute('aria-hidden', 'true');
  activeDrawer = null;
  $$('[data-open-drawer]').forEach((button) => button.classList.remove('active'));
  $('[data-view="console"]')?.classList.add('active');
  $('[data-action="toggle-drawer"]')?.setAttribute('aria-checked', 'false');
}

function setMobilePane(value) {
  const pane = normalizeMobilePane(value);
  workspace.classList.toggle('mobile-conversation', pane === 'conversation');
  $$('[data-mobile-pane]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.mobilePane === pane));
  });
}

function setPaneVisible(pane, visible) {
  const teamHidden = workspace.classList.contains('hide-team');
  const conversationHidden = workspace.classList.contains('hide-conversation');
  if (!visible && ((pane === 'team' && conversationHidden) || (pane === 'conversation' && teamHidden))) {
    showToast('Keep at least one workspace pane visible.');
    return;
  }
  workspace.classList.toggle(`hide-${pane}`, !visible);
  const action = $(`[data-action="toggle-${pane}"]`);
  action?.setAttribute('aria-checked', String(visible));
  if (visible && matchMedia('(max-width: 820px)').matches) setMobilePane(pane);
}

function toggleDetails(button) {
  const details = button.nextElementSibling;
  if (!details) return;
  const expanded = details.hidden;
  details.hidden = !expanded;
  button.classList.toggle('expanded', expanded);
  button.setAttribute('aria-expanded', String(expanded));
}

function runAction(action, source) {
  if (action === 'dismiss-banner') {
    // Keep the status element in the DOM. Remote Control updates it after a
    // session selection; removing it made the selection handler throw and
    // left the phone on a misleading, non-live session card.
    $('.honesty-banner')?.setAttribute('hidden', '');
    workspace.classList.add('banner-dismissed');
  } else if (action === 'close-drawer') {
    closeDrawer();
  } else if (action === 'toggle-details') {
    return;
  } else if (action === 'new-project' || action === 'project-required') {
    showToast(connectionRequirement('project'));
  } else if (action === 'create-local') {
    showToast(connectionRequirement('create'));
  } else if (action === 'provider-required') {
    showToast(connectionRequirement('provider', source?.dataset.provider));
  } else if (action === 'focus-composer') {
    setMobilePane('conversation');
    messageInput.focus();
  } else if (action === 'clear-draft') {
    messageInput.value = '';
    writeStorage(draftKey, '');
    showToast('Local draft cleared.');
  } else if (action === 'shortcuts') {
    shortcutsDialog.showModal();
  } else if (action === 'close-shortcuts') {
    shortcutsDialog.close();
  } else if (action === 'account') {
    if (clerk?.isSignedIn) void clerk.signOut().then(resetRemoteUi);
    else {
      accountDialog.showModal();
      mountAccount(accountMode);
    }
  } else if (action === 'account-signup') {
    accountDialog.showModal();
    mountAccount('signup');
  } else if (action === 'account-mode') {
    mountAccount(source?.dataset.mode === 'signup' ? 'signup' : 'signin');
  } else if (action === 'close-account') {
    accountDialog.close();
  } else if (action === 'toggle-team') {
    setPaneVisible('team', workspace.classList.contains('hide-team'));
  } else if (action === 'toggle-conversation') {
    setPaneVisible('conversation', workspace.classList.contains('hide-conversation'));
  } else if (action === 'toggle-drawer') {
    if (activeDrawer) closeDrawer();
    else openDrawer('guard');
    $('[data-action="toggle-drawer"]')?.setAttribute('aria-checked', String(Boolean(activeDrawer)));
  } else if (action === 'fullscreen') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => showToast('Fullscreen is unavailable in this browser.'));
    else document.exitFullscreen?.();
  }
  closeMenus();
}

function mountAccount(mode) {
  if (!clerk) return;
  accountMode = mode === 'signup' ? 'signup' : 'signin';
  const mount = $('#clerkMount');
  const title = $('#accountDialogTitle');
  try { clerk.unmountSignIn?.(mount); } catch { /* no sign-in component mounted */ }
  try { clerk.unmountSignUp?.(mount); } catch { /* no sign-up component mounted */ }
  mount.replaceChildren();
  title.textContent = accountMode === 'signup'
    ? 'Create your Helmian Cloud account'
    : 'Sign in to Helmian Cloud';
  if (accountMode === 'signup' && typeof clerk.mountSignUp === 'function') {
    clerk.mountSignUp(mount);
  } else {
    clerk.mountSignIn(mount);
  }
}

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-menu-trigger]');
  if (trigger) {
    event.stopPropagation();
    toggleMenu(trigger.dataset.menuTrigger, trigger);
    return;
  }
  if (!event.target.closest('[data-menu]')) closeMenus();

  const drawerButton = event.target.closest('[data-open-drawer]');
  if (drawerButton) {
    openDrawer(drawerButton.dataset.openDrawer);
    return;
  }
  const railCommand = event.target.closest('[data-command="toggle-rail"]');
  if (railCommand) {
    setRailExpanded(!appShell.classList.contains('rail-expanded'));
    return;
  }
  const paneButton = event.target.closest('[data-mobile-pane]');
  if (paneButton) {
    setMobilePane(paneButton.dataset.mobilePane);
    return;
  }
  const themeButton = event.target.closest('[data-theme-choice]');
  if (themeButton) {
    setTheme(themeButton.dataset.themeChoice);
    closeMenus();
    return;
  }
  const detailButton = event.target.closest('[data-action="toggle-details"]');
  if (detailButton) {
    toggleDetails(detailButton);
    return;
  }
  const actionButton = event.target.closest('[data-action]');
  if (actionButton) runAction(actionButton.dataset.action, actionButton);
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const draft = messageInput.value.trim();
  if (!draft) {
    showToast('Write a message first.');
    messageInput.focus();
    return;
  }
  writeStorage(draftKey, messageInput.value);
  if (!remoteTransport || !selectedControl) {
    $('#draftNotice').textContent = 'Not sent — select an online account-owned Desktop session.';
    showToast('Select your connected Helmian Desktop session before sending.');
    openDrawer('projects');
    return;
  }
  void sendRemoteInstruction(draft);
});

$('#enrollmentForm')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = $('#enrollmentCode').value.trim();
  if (!/^\d{8}$/.test(code)) {
    showToast('Enter the eight-digit code shown by Helmian Desktop.');
    return;
  }
  void remoteApi.confirmEnrollment(code).then(async () => {
    $('#enrollmentCode').value = '';
    showToast('Desktop enrollment confirmed. Waiting for Desktop redemption and heartbeat.');
    await refreshDesktopList();
  }).catch((error) => showToast(error.message));
});

messageInput.addEventListener('input', () => {
  writeStorage(draftKey, messageInput.value);
  $('#draftNotice').textContent = 'Draft saved locally on this device.';
});

$$('.history-filters button').forEach((button) => {
  button.addEventListener('click', () => {
    $$('.history-filters button').forEach((item) => item.classList.toggle('active', item === button));
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeMenus();
    if (shortcutsDialog.open) shortcutsDialog.close();
    else if (activeDrawer) closeDrawer();
    return;
  }
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === 'k') {
    event.preventDefault();
    setMobilePane('conversation');
    messageInput.focus();
  } else if (event.key === '1') {
    event.preventDefault();
    setPaneVisible('team', true);
  } else if (event.key === '2') {
    event.preventDefault();
    setPaneVisible('conversation', true);
  } else if (event.key === '3') {
    event.preventDefault();
    if (activeDrawer) closeDrawer(); else openDrawer('guard');
  }
});

setTheme(readStorage(themeKey, 'midnight'));
messageInput.value = readStorage(draftKey);
setMobilePane('team');
if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/herald/sw.js', { scope: '/herald/' }).catch(() => {}));
}
void initializeAccountRemoteControl();

async function initializeAccountRemoteControl() {
  setRemoteStatus('Checking account configuration…', false);
  try {
    const config = await remoteApi.config();
    const account = config?.accountIdentity;
    if (!account?.configured || !account?.publishableKey) {
      setRemoteStatus(account?.state === 'misconfigured'
        ? 'Account sign-in configuration is incomplete. Remote Control is unavailable.'
        : 'Account sign-in is not configured. Remote Control is unavailable.', false);
      $('#accountButton').disabled = true;
      return;
    }
    clerk = await loadClerkBrowser(account.publishableKey);
    remoteApi = createAccountRemoteControlApi({
      token: async () => clerk?.session?.getToken?.() ?? null,
    });
    clerk.addListener?.(() => void applyAccountState(config));
    await applyAccountState(config);
  } catch (error) {
    setRemoteStatus(`Remote Control is unavailable: ${error.message}`, false);
  }
}

async function applyAccountState(config) {
  if (!clerk?.isSignedIn) {
    remoteTransport?.close(); remoteTransport = null; selectedControl = null;
    activeAccountId = null;
    $('#accountButton').textContent = 'Sign in';
    $('#accountSignupButton').hidden = false;
    setRemoteStatus('Sign in to see only the Desktops owned by your Helmian account.', false);
    $('#desktopList').replaceChildren();
    $('#desktopEmpty').hidden = false;
    if (accountDialog.open) mountAccount(accountMode);
    else if (requestedAccountMode !== 'signin') {
      accountDialog.showModal();
      mountAccount(requestedAccountMode);
    }
    return;
  }
  const nextAccountId = clerk.user?.id ?? null;
  if (activeAccountId && activeAccountId !== nextAccountId) {
    remoteTransport?.close(); remoteTransport = null; selectedControl = null;
  }
  activeAccountId = nextAccountId;
  accountDialog.close();
  $('#accountButton').textContent = 'Sign out';
  $('#accountSignupButton').hidden = true;
  setRemoteStatus('Signed in. Checking your account-owned Desktop sessions…', false);
  await refreshDesktopList();
  if (config?.transport?.realtimeClientActive !== true) {
    setRemoteStatus('Your account is signed in, but scoped realtime transport is not configured.', false);
  }
}

async function refreshDesktopList() {
  const list = $('#desktopList');
  try {
    const { desktops = [] } = await remoteApi.list();
    list.replaceChildren(...desktops.flatMap((desktop) => desktop.sessions.map((session) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.desktopId = desktop.desktopId;
      button.dataset.sessionId = session.sessionId;
      button.innerHTML = `<span><strong>${escapeHtml(desktop.displayName)}</strong><small>${escapeHtml(session.project.name)} · ${escapeHtml(session.name)} · ${escapeHtml(session.state)}</small></span>`;
      button.addEventListener('click', () => void selectRemoteSession(desktop, session));
      return button;
    }))); 
    $('#desktopEmpty').hidden = list.childElementCount > 0;
    // Enrollment is only useful until this account has a live desktop session.
    // Keeping the eight-digit form beside an already selectable session made
    // the phone look unpaired and repeatedly sent people back into setup.
    $('#enrollmentForm').hidden = list.childElementCount > 0;
    setRemoteStatus(list.childElementCount
      ? 'Choose one live session from your account-owned Desktop.'
      : 'No live Desktop session is connected to this account.', false);
  } catch (error) {
    list.replaceChildren(); $('#desktopEmpty').hidden = false; $('#enrollmentForm').hidden = false;
    setRemoteStatus(error.status === 401 ? 'Your account session expired. Sign in again.' : error.message, false);
  }
}

async function selectRemoteSession(desktop, session) {
  remoteTransport?.close(); remoteTransport = null; selectedControl = null;
  setRemoteStatus('Selecting the account-owned Desktop session…', false);
  try {
    await remoteApi.select(desktop.desktopId, session.sessionId);
    const control = await remoteApi.control();
    const Ably = await loadAblyBrowser();
    remoteTransport = await createAblyAccountControl({
      Ably,
      tokenProvider: remoteApi.token,
      onResult: receiveRemoteResult,
      onState: ({ state }) => {
        const live = ['connected', 'attached'].includes(state);
        setRemoteStatus(live ? `Connected to ${desktop.displayName} · ${session.name}`
          : `Desktop transport: ${state}`, live);
      },
    });
    selectedControl = control.session;
    $('#selectedProjectName').textContent = session.project.name;
    $('#desktopControlTitle').textContent = `${desktop.displayName} — ${session.name}`;
    $('.conversation-pane .quiet-status').textContent = desktop.displayName;
    setRemoteStatus(`Connected to ${desktop.displayName} · ${session.name}`, true);
    closeDrawer();
  } catch (error) {
    remoteTransport?.close(); remoteTransport = null;
    setRemoteStatus(error.code === 'desktop_offline'
      ? 'That Desktop is offline or stale. Nothing was sent.' : error.message, false);
  }
}

async function sendRemoteInstruction(text) {
  const session = selectedControl;
  try {
    const sent = await remoteTransport.send('instruction.submit', {
      projectId: session.project.id,
      sessionId: session.session.id,
      text,
      confirmed: true,
    });
    delivery.queued(sent.requestId, 'instruction.submit');
    renderHistory();
    const article = document.createElement('article');
    article.className = 'message user-message';
    article.innerHTML = `<div class="message-body"><div class="message-meta"><strong>You</strong><span>Sent to Desktop</span></div><p>${escapeHtml(text)}</p></div>`;
    $('#conversation').append(article);
    $('#draftNotice').textContent = 'Accepted by the secure relay; waiting for Desktop acknowledgement.';
    messageInput.value = ''; writeStorage(draftKey, '');
    showToast('Queued securely. Waiting for Helmian Desktop acknowledgement.');
  } catch (error) {
    $('#draftNotice').textContent = 'Not sent — the Desktop transport is unavailable.';
    showToast(error.message);
  }
}

function receiveRemoteResult(result) {
  const settled = delivery.settle(result);
  if (!settled) return;
  renderHistory();
  const article = document.createElement('article');
  article.className = 'message helmian-message';
  article.innerHTML = `<div class="message-body"><div class="message-meta"><strong>Helmian Desktop</strong><span>${escapeHtml(settled.state)}</span></div><p>${escapeHtml(settled.message)}</p></div>`;
  $('#conversation').append(article);
  $('#draftNotice').textContent = settled.message;
}

function renderHistory() {
  const rows = delivery.list();
  const root = $('#remoteHistory');
  if (!rows.length) return;
  root.replaceChildren(...rows.map((row) => {
    const item = document.createElement('p');
    item.textContent = `${row.state}: ${row.message}`;
    return item;
  }));
}

function setRemoteStatus(message, live) {
  const connection = $('#connectionState');
  if (connection) {
    connection.lastChild.textContent = live ? ' Desktop connected' : ' Desktop not connected';
    connection.classList.toggle('live', live);
  }
  const status = $('#remoteStatusText');
  if (status) status.textContent = message;
  const state = $('#desktopControlState');
  const copy = $('#desktopControlMessage');
  if (state) state.textContent = live ? 'Live' : 'Waiting';
  $('#desktopControlIntro')?.toggleAttribute('hidden', live);
  if (copy) copy.textContent = live
    ? ''
    : 'Connecting to Helmian.';
}

function resetRemoteUi() {
  remoteTransport?.close(); remoteTransport = null; selectedControl = null;
  $('#selectedProjectName').textContent = 'No project open';
  $('#desktopList').replaceChildren(); $('#desktopEmpty').hidden = false;
  $('#accountButton').textContent = 'Sign in';
  $('#accountSignupButton').hidden = false;
  setRemoteStatus('Signed out. No Desktop control is active.', false);
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}
