// Meet Maestro — the one-time activation ceremony (Troy's design,
// 2026-11-09). Maestro is always-on underneath; this is the moment
// a new person meets him on purpose: who he is, and the four real
// systems the click turns on with their knowledge — the Executive
// Guard, the librarian and its knowledge base, the rule base, and
// Maestro in the middle of every channel.
//
// app.js boot awaits runMaestroActivationGate after the member
// session resolves and before any view is shown. The gate reads
// GET /api/admin/maestro-activation; the server's stamp rule (see
// src/cloud/maestro-activation.mjs) answers needsActivation only
// for a brand-new workspace that has not met Maestro yet. Stamped
// workspaces, pre-feature workspaces, and any failure at all →
// the gate steps aside and the app opens. The ceremony NEVER
// blocks a workspace: a failed read proceeds silently, and a
// failed activation write still lets the person in (the server
// fails soft the same way, so the two halves agree).
//
// The markup lives in index.html (#maestro-activation); this
// module only shows/hides it and carries the click. Copy lives in
// the markup, not here.

export const ACTIVATION_API_PATH = '/api/admin/maestro-activation';

/**
 * The pure gate decision over the server's answer. Shows only
 * when the server says this workspace still needs its meeting
 * AND the person looking can perform it — an auditor reads and
 * never authors, so the ceremony is not theirs to click through;
 * the workspace's owner performs the activation.
 */
export function ceremonyModel(body, role) {
  if (!body || body.valid !== true) return { show: false };
  if (String(role ?? '').toLowerCase() === 'auditor') return { show: false };
  return { show: body.needsActivation === true };
}

/**
 * Run the gate. Resolves true when the ceremony was shown (and
 * the click carried through), false when it stepped aside. Never
 * throws: every failure is a step-aside.
 */
export async function runMaestroActivationGate({
  role,
  fetchImpl,
  doc,
} = {}) {
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  const documentImpl = doc ?? (typeof document !== 'undefined' ? document : null);
  if (!doFetch || !documentImpl) return false;
  try {
    const res = await doFetch(ACTIVATION_API_PATH, { credentials: 'same-origin' });
    if (!res?.ok) return false;
    const body = await res.json().catch(() => null);
    if (!ceremonyModel(body, role).show) return false;
    const section = documentImpl.getElementById('maestro-activation');
    const button = documentImpl.getElementById('maestro-activation-button');
    if (!section || !button) return false;
    section.hidden = false;
    if (typeof button.focus === 'function') button.focus();
    await new Promise((resolve) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await doFetch(ACTIVATION_API_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
        } catch { /* the server fails soft; so does the click */ }
        section.hidden = true;
        resolve();
      }, { once: true });
    });
    return true;
  } catch {
    return false;
  }
}
