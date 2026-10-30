// The welcome page (0.6.2). Opens once, on first install.
// Name or email, tick the AIs, one Connect Scribe button. Mailboxes come from
// the ticks (background/defaults.js AI_CHOICES); nothing else is typed.
import { AI_CHOICES } from '../background/defaults.js';

const $ = (id) => document.getElementById(id);
// Tick boxes come from the one AI table (background/defaults.js).
for (const ai of AI_CHOICES) {
  const label = document.createElement('label');
  label.className = 'ai';
  const box = document.createElement('input');
  box.type = 'checkbox'; box.name = 'ai'; box.value = ai.key;
  const text = document.createElement('span');
  text.textContent = ai.label;
  label.append(box, text);
  if (ai.note) { const n = document.createElement('span'); n.className = 'ai-note'; n.textContent = ai.note; label.append(n); }
  $('ais').append(label);
}
const C = globalThis.HelmionConnect;
let scribeUrl = '';

function show(kind, text) {
  const el = $('status');
  el.hidden = false;
  el.className = `status ${kind}`;
  el.textContent = kind === 'error' ? `Problem: ${text}` : text;
  if (kind === 'error') el.setAttribute('role', 'alert');
}

async function load() {
  const s = await C.send('helmion:scribe-settings', { settings: {} });
  if (s.ok && s.settings) scribeUrl = s.settings.baseUrl || '';
  else show('error', `Guard could not load its settings. ${s.error || ''}`);
  const p = await C.send('helmion:onboarding', { action: 'get' });
  if (p.ok && p.profile) {
    $('who').value = p.profile.name || '';
    for (const box of document.querySelectorAll('input[name=ai]')) box.checked = (p.profile.ais || []).includes(box.value);
  }
  if (s.ok && s.settings && s.settings.signedIn) show('ok', 'Scribe is already connected.');
}

$('connect').addEventListener('click', () => {
  // Checks first, all synchronous, so the permission prompt keeps the click.
  const name = $('who').value.trim();
  const ais = [...document.querySelectorAll('input[name=ai]:checked')].map((b) => b.value);
  if (!name) { show('error', 'Type your name or email in step 1 first.'); $('who').focus(); return; }
  if (!ais.length) { show('error', 'Tick at least one AI in step 2 first.'); return; }
  if (!scribeUrl) { show('error', 'Guard has no Scribe server address yet. Wait a second and click again, or reload this page.'); return; }
  $('connect').disabled = true;
  show('busy', 'Asking your browser for permission. Choose Allow.');
  C.connect(scribeUrl, show, () => C.send('helmion:onboarding', { action: 'save', profile: { name, ais } }))
    .finally(() => { $('connect').disabled = false; });
});

load();
