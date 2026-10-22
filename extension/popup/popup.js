// The toolbar popup: what has been flagged, and how to get it out.
//
// It is the only place a user can read the ledger, so it has three jobs and no
// others — show the counts, export the file, clear the log. It never edits an
// entry: a record you can quietly amend is not a record.
//
// Plain script, no bundler, no dependency. Chrome loads this file as written.

const $ = (id) => document.getElementById(id);

function ask(type) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type }, (response) => {
        void chrome.runtime.lastError;
        resolve(response || { ok: false, error: 'the background worker did not answer' });
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
    }
  });
}

function fmt(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Escapes nothing — everything goes in via textContent, never innerHTML. */
function row(entry) {
  const li = document.createElement('li');
  li.className = entry.kind === 'unsourced-claim' ? 'entry note' : 'entry danger';

  const head = document.createElement('div');
  head.className = 'entry-head';

  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = entry.kind === 'unsourced-claim' ? 'UNSOURCED CLAIM' : 'DESTRUCTIVE';
  head.appendChild(kind);

  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = `${fmt(entry.timestamp)} · ${entry.site || 'unknown site'}`;
  head.appendChild(when);
  li.appendChild(head);

  const text = document.createElement('code');
  text.className = 'entry-text';
  text.textContent = entry.text || '';
  li.appendChild(text);

  const matched = document.createElement('div');
  matched.className = 'matched';
  matched.textContent = entry.matched ? `matched: ${entry.matched}` : '';
  li.appendChild(matched);

  // Says so when the context could not be captured, rather than showing a blank
  // that reads as "nothing was asked".
  const ctx = document.createElement('div');
  ctx.className = 'ctx';
  ctx.textContent = entry.contextCaptured
    ? `you asked: ${entry.query || '(the prompt was not on the page)'}`
    : 'the surrounding conversation could not be captured for this one';
  li.appendChild(ctx);

  return li;
}

async function refresh() {
  const health = await ask('helmion:guard-status');
  const status = health.ok ? health.status : {};
  const protection = status && status.protection;
  const claims = status && status.claims;

  $('protectionDot').className = `status-dot ${protection || 'unknown'}`;
  $('claimsDot').className = `status-dot ${claims || 'unknown'}`;
  $('protectionStatus').textContent = protection === 'active'
    ? 'Active on the most recently checked page.'
    : protection === 'limited'
      ? 'Active in compatibility mode.'
      : protection === 'needs-attention'
        ? 'Needs attention; checks may be incomplete.'
        : 'Open or reload a supported AI page to check.';
  $('claimsStatus').textContent = claims === 'active'
    ? 'Active on the most recently checked page.'
    : claims === 'limited'
      ? 'Active in compatibility mode.'
      : claims === 'unavailable'
        ? 'Temporarily unavailable.'
        : 'Open or reload a supported AI page to check.';
  $('statusHelp').textContent = protection === 'needs-attention'
    ? 'Reload the page. If this status remains, do not rely on Guard for that page.'
    : '';

  const stats = await ask('helmion:ledger-stats');
  if (!stats.ok) {
    $('range').textContent = `Could not read the log: ${stats.error}`;
    return;
  }

  $('statTotal').textContent = stats.stats.total;
  $('statDestructive').textContent = stats.stats.destructive;
  $('statUnsourced').textContent = stats.stats.unsourced;
  $('statFlags').textContent = stats.stats.flags ?? 0;
  $('range').textContent = stats.stats.total
    ? `${fmt(stats.stats.oldest)} → ${fmt(stats.stats.newest)} · ${stats.stats.sites.length} site(s) · cap ${stats.stats.limit}`
    : '';

  const held = await ask('helmion:ledger');
  const list = $('entries');
  list.textContent = '';
  const entries = (held.ok ? held.entries : []).slice(-25).reverse();
  entries.forEach((entry) => list.appendChild(row(entry)));
  $('empty').hidden = entries.length > 0;
}

$('exportBtn').addEventListener('click', async () => {
  const result = await ask('helmion:ledger-export');
  if (!result.ok) {
    $('range').textContent = `Export failed: ${result.error}`;
    return;
  }
  // A blob URL and an anchor. No "downloads" permission is needed for this, so
  // the extension keeps its single-permission promise.
  const blob = new Blob([JSON.stringify(result.bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `helmion-guard-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// Clearing is destructive and takes two clicks. The same reasoning as masking a
// dangerous code block: one deliberate confirmation before something is gone.
$('clearBtn').addEventListener('click', () => { $('confirm').hidden = false; });
$('cancelClear').addEventListener('click', () => { $('confirm').hidden = true; });
$('confirmClear').addEventListener('click', async () => {
  await ask('helmion:ledger-clear');
  $('confirm').hidden = true;
  refresh();
});

// OPT-IN cloud upload settings. Off by default; the background worker only
// uploads when this is enabled AND a device token is set. See
// background/upload.js — this UI needs Troy's manual browser testing.
function askWithPayload(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        void chrome.runtime.lastError;
        resolve(response || { ok: false, error: 'the background worker did not answer' });
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
    }
  });
}

async function refreshUploadSettings() {
  const result = await askWithPayload('helmion:guard-upload-settings', { settings: {} });
  if (result.ok && result.settings) {
    $('uploadEnabled').checked = result.settings.enabled === true;
    $('uploadStatus').textContent = result.settings.enabled
      ? (result.settings.hasToken ? 'Upload enabled. New findings will be sent to your Helmian cloud.' : 'Upload enabled, but no device token is set — nothing will be sent.')
      : 'Upload is off. Findings stay on this machine.';
  }
}

$('uploadSave').addEventListener('click', async () => {
  const result = await askWithPayload('helmion:guard-upload-settings', {
    settings: { enabled: $('uploadEnabled').checked, deviceToken: $('uploadToken').value },
  });
  if (!result.ok) { $('uploadStatus').textContent = `Settings not saved: ${result.error}`; return; }
  $('uploadToken').value = '';
  await refreshUploadSettings();
});

$('uploadNow').addEventListener('click', async () => {
  $('uploadStatus').textContent = 'Uploading…';
  const result = await ask('helmion:guard-upload');
  if (!result.ok) { $('uploadStatus').textContent = `Upload failed: ${result.error}`; return; }
  if (result.skipped) { $('uploadStatus').textContent = result.skipped === 'not-enabled' ? 'Upload is off — enable it above first.' : 'No device token set — save one above first.'; return; }
  $('uploadStatus').textContent = result.uploaded
    ? `Uploaded ${result.uploaded} finding${result.uploaded === 1 ? '' : 's'}${result.remaining ? `, ${result.remaining} remaining` : ''}.`
    : 'Nothing new to upload.';
});

refresh();
refreshUploadSettings();

// ─── Executive Guard and Flags settings (opt-in, off by default) ────────────
//
// Both need a host permission for the URL the user typed. It is requested
// here, inside the click, because Chrome and Firefox only grant optional
// permissions from a user gesture. Nothing is requested at install.
// NEEDS A REAL-BROWSER CHECK: the permission prompt and pairing flow are
// tested only through the worker in Node, not clicked in Chrome/Firefox/Edge.

function originFor(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

function requestOrigin(value) {
  const origin = originFor(value);
  if (!origin) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      if (!chrome.permissions || typeof chrome.permissions.request !== 'function') { resolve(false); return; }
      const result = chrome.permissions.request({ origins: [origin] }, (granted) => {
        void chrome.runtime.lastError;
        resolve(Boolean(granted));
      });
      if (result && typeof result.then === 'function') result.then((g) => resolve(Boolean(g)), () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

async function refreshExecutiveSettings() {
  const result = await askWithPayload('helmion:executive-settings', { settings: {} });
  if (!result.ok || !result.settings) return;
  const s = result.settings;
  $('execEnabled').checked = s.enabled === true;
  $('execUrl').value = s.serverUrl || '';
  $('execStatus').textContent = !s.enabled
    ? 'Off. Guard decides on this computer.'
    : !s.paired
      ? 'On, but not paired yet. Decisions stay local until pairing succeeds.'
      : `On and paired. Server key id ${s.keyId} (compare it with the id your server printed).`;
}

$('execSave').addEventListener('click', async () => {
  const url = $('execUrl').value.trim();
  if ($('execEnabled').checked && url) {
    const granted = await requestOrigin(url);
    if (!granted) { $('execStatus').textContent = 'Permission to reach that server was not granted, so nothing was saved.'; return; }
  }
  const saved = await askWithPayload('helmion:executive-settings', {
    settings: { enabled: $('execEnabled').checked, serverUrl: url, deviceToken: $('execToken').value || undefined },
  });
  if (!saved.ok) { $('execStatus').textContent = `Not saved: ${saved.error}`; return; }
  $('execToken').value = '';
  if ($('execEnabled').checked && url) {
    const pair = await ask('helmion:executive-pair');
    if (!pair.ok) { $('execStatus').textContent = `Saved, but pairing failed: ${pair.error}`; return; }
  }
  await refreshExecutiveSettings();
});

async function refreshFlagsSettings() {
  const result = await askWithPayload('helmion:flags-settings', { settings: {} });
  if (!result.ok || !result.settings) return null;
  const s = result.settings;
  $('flagsEnabled').checked = s.enabled === true;
  $('flagsUrl').value = s.baseUrl || '';
  $('flagsScan').checked = s.scanBeforeSend === true;
  $('flagsBudget').value = String(s.dailyBudget || 100);
  $('flagsKey').placeholder = s.hasKey ? 'Key saved (paste a new one to replace it)' : 'smk_… (shown once on your dashboard)';
  let text;
  if (!s.enabled) text = 'Off. Flags are shown and logged on this computer only.';
  else if (!s.baseUrl || !s.hasKey) text = 'On, but the server URL or API key is missing, so nothing is sent.';
  else if (s.keyRejected) text = 'The Flags server refused the API key (wrong, revoked, or missing a scope). Paste a new key.';
  else if (s.pausedUntil) text = `The Flags account hit its daily call limit. Paused until ${new Date(s.pausedUntil).toLocaleString()}.`;
  else text = `On. ${s.callsToday} of ${s.dailyBudget} calls used today.`;
  if (s.queued) text += ` ${s.queued} waiting to be sent.`;
  if (s.lastError && s.enabled && !s.keyRejected && !s.pausedUntil) text += ` Last problem: ${s.lastError}`;
  $('flagsStatus').textContent = text;
  return s;
}

function renderAlerts(result) {
  const list = $('flagsAlerts');
  list.replaceChildren();
  if (!result || !result.ok && !result.alerts) { $('flagsAlertsStatus').textContent = 'Could not check.'; return; }
  const alerts = result.alerts || [];
  for (const a of alerts) {
    // textContent only: alert text comes from the server.
    const li = document.createElement('li');
    li.className = `alert sev-${a.severity}`;
    const head = document.createElement('strong');
    head.textContent = `${a.severity.toUpperCase()} · ${a.category}${a.source_ai ? ` · ${a.source_ai}` : ''}`;
    const reason = document.createElement('div');
    reason.textContent = a.reason;
    li.append(head, reason);
    if (a.excerpt) { const ex = document.createElement('div'); ex.className = 'muted'; ex.textContent = a.excerpt; li.append(ex); }
    const when = document.createElement('div'); when.className = 'muted';
    when.textContent = a.created_at ? new Date(a.created_at).toLocaleString() : '';
    li.append(when);
    list.append(li);
  }
  const skipped = {
    'not-enabled': 'Reporting is off.', 'no-url': 'No server URL set.', 'no-key': 'No API key set.',
    'key-rejected': 'The API key was refused.', 'daily-limit': 'Paused: daily call limit.', budget: 'Daily call budget used up.',
  }[result.skipped];
  $('flagsAlertsStatus').textContent = skipped
    || (alerts.length ? `${result.unseen || 0} new. Last checked ${result.polledAt ? new Date(result.polledAt).toLocaleTimeString() : 'never'}.` : 'No high or critical flags.');
}

async function refreshAlerts(force) {
  const result = await askWithPayload('helmion:flags-alerts', { options: { force } });
  renderAlerts(result);
  // Opening the popup counts as seeing them.
  if (result && result.ok && result.unseen) askWithPayload('helmion:flags-alerts', { options: { markSeen: true } });
}

$('flagsSave').addEventListener('click', async () => {
  const url = $('flagsUrl').value.trim();
  if ($('flagsEnabled').checked && url) {
    const granted = await requestOrigin(url);
    if (!granted) { $('flagsStatus').textContent = 'Permission to reach that URL was not granted, so nothing was saved.'; return; }
  }
  const budget = $('flagsBudget').value.trim();
  const saved = await askWithPayload('helmion:flags-settings', {
    settings: {
      enabled: $('flagsEnabled').checked,
      baseUrl: url,
      apiKey: $('flagsKey').value || undefined,
      scanBeforeSend: $('flagsScan').checked,
      dailyBudget: budget ? Number(budget) : undefined,
    },
  });
  // The key field is cleared whatever happened; it is never shown again.
  $('flagsKey').value = '';
  if (!saved.ok) { $('flagsStatus').textContent = `Not saved: ${saved.error}`; return; }
  await refreshFlagsSettings();
});

$('flagsRefresh').addEventListener('click', () => refreshAlerts(true));

refreshExecutiveSettings();
refreshFlagsSettings().then((s) => { if (s && s.enabled) refreshAlerts(false); });
