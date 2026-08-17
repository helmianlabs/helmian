const filters = document.querySelector('#activity-filters');
const action = document.querySelector('#activity-action');
const actor = document.querySelector('#activity-actor');
const decision = document.querySelector('#activity-decision');
const from = document.querySelector('#activity-from');
const to = document.querySelector('#activity-to');
const clear = document.querySelector('#activity-clear');
const items = document.querySelector('#activity-items');
const status = document.querySelector('#activity-status');
const count = document.querySelector('#activity-count');
const older = document.querySelector('#load-older');
let cursor = null;

function paramsForRequest(includeCursor) {
  const params = new URLSearchParams();
  for (const [key, value] of [['action', action.value.trim()], ['actor', actor.value.trim()], ['status', decision.value], ['from', from.value], ['to', to.value]]) if (value) params.set(key, value);
  if (includeCursor && cursor) params.set('cursor', cursor);
  return params;
}

function eventCard(event) {
  const card = document.createElement('article');
  const header = document.createElement('header');
  const title = document.createElement('div');
  const kind = document.createElement('div'); kind.className = 'kind'; kind.textContent = event.actionType || 'RECORDED ACTION';
  const heading = document.createElement('h3'); heading.textContent = event.summary || 'Recorded Organization action';
  title.append(kind, heading);
  const time = document.createElement('time'); time.dateTime = event.createdAt || ''; time.textContent = event.createdAt ? new Date(event.createdAt).toLocaleString() : 'Recorded time unavailable';
  header.append(title, time);
  const detail = document.createElement('p'); detail.textContent = event.summary || 'No display-safe summary was recorded.';
  const meta = document.createElement('p');
  const statusLabel = document.createElement('span'); statusLabel.className = 'status'; statusLabel.textContent = String(event.status || 'RECORDED').toUpperCase();
  const source = document.createElement('span'); source.className = 'source'; source.textContent = ` · ${event.actor || 'unknown actor'}${event.actorRole ? ` (${event.actorRole})` : ''}`;
  meta.append(statusLabel, source); card.append(header, detail, meta); return card;
}

function render(body, append) {
  if (!append) items.replaceChildren();
  const events = Array.isArray(body.events) ? body.events : [];
  if (!append && events.length === 0) { const empty = document.createElement('p'); empty.textContent = 'No durable audit records match these filters.'; items.append(empty); }
  for (const event of events) items.append(eventCard(event));
  cursor = body.nextCursor ?? null;
  older.hidden = !body.hasMore || !cursor;
  count.textContent = append ? `${items.querySelectorAll('article').length} SHOWN` : body.hasMore ? `${events.length} SHOWN · MORE AVAILABLE` : `${events.length} RECORDED`;
  status.textContent = events.length === 0 ? 'No durable audit records match these filters.' : body.hasMore ? 'Showing durable Organization history. Older records are available.' : 'Showing durable Organization history. This is the end of the current result set.';
}

async function load({ append = false } = {}) {
  status.textContent = append ? 'Loading older Organization history…' : 'Loading Organization history…';
  older.disabled = append;
  try {
    const response = await fetch(`/api/admin/events?${paramsForRequest(append)}`, { credentials: 'same-origin' });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.code || 'History unavailable'), { status: response.status });
    render(body, append);
  } catch (error) {
    if (!append) items.replaceChildren();
    older.hidden = true;
    status.textContent = error.status === 403 ? 'History unavailable: active Organization membership is required.' : `History unavailable: ${error.message}`;
  } finally { older.disabled = false; }
}

filters.addEventListener('submit', (event) => { event.preventDefault(); cursor = null; void load(); });
clear.addEventListener('click', () => { filters.reset(); cursor = null; void load(); });
older.addEventListener('click', () => { if (cursor) void load({ append: true }); });
void load();
