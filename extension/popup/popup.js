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
  const stats = await ask('helmion:ledger-stats');
  if (!stats.ok) {
    $('range').textContent = `Could not read the log: ${stats.error}`;
    return;
  }

  $('statTotal').textContent = stats.stats.total;
  $('statDestructive').textContent = stats.stats.destructive;
  $('statUnsourced').textContent = stats.stats.unsourced;
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

refresh();
