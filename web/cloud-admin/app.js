const signedOut = document.querySelector('#signed-out');
const signedIn = document.querySelector('#signed-in');
const actor = document.querySelector('#actor');
const out = document.querySelector('#result');
document.querySelector('#login').onclick = () => { window.location.href = '/admin/auth/login'; };
async function load() {
  const session = await fetch('/api/admin/session', { credentials: 'same-origin' });
  if (!session.ok) { signedOut.hidden = false; signedIn.hidden = true; return; }
  const sessionBody = await session.json();
  signedOut.hidden = true; signedIn.hidden = false;
  actor.textContent = `Signed in as ${sessionBody.actor.role} for tenant ${sessionBody.actor.tenantId}`;
  const surface = await fetch('/api/admin/control-surface', { credentials: 'same-origin' });
  out.textContent = JSON.stringify(await surface.json(), null, 2);
}
document.querySelector('#refresh').onclick = () => load().catch(() => { out.textContent = 'Control surface unavailable.'; });
load().catch(() => { signedOut.hidden = false; signedIn.hidden = true; });
