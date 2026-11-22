// Provenance settings surface (Scribe 1154, live bite 4): renders the
// Milestone 4 weighting sliders and the Milestone 3 guard badges in the
// workspace Settings view. The slider descriptors mirror
// src/core/provenance-profile-sync.mjs WEIGHTING_SLIDERS exactly — a test
// pins the two copies together so the surface and the guardrails cannot
// drift apart. The profile itself is read and written through
// /api/admin/provenance/profile, which stores the validated sync payload
// per tenant; Profile Sync carries it to the tenant's devices from there.

export const WEIGHTING_SLIDERS = Object.freeze([
  { key: 'provenanceWeight', label: 'Provenance Weight', min: 0, max: 1, step: 0.05, description: 'How much a source\'s cryptographic attribution chain counts toward its claims.' },
  { key: 'financialIndependenceWeight', label: 'Financial Independence Weight', min: 0, max: 1, step: 0.05, description: 'How much weight independent, conflict-free evidence carries against interested sources.' },
  { key: 'institutionalConsensusWeight', label: 'Institutional Consensus Weight', min: 0, max: 1, step: 0.05, description: 'How much the institutional consensus cluster counts toward a settled reading.' },
  { key: 'replicationWeight', label: 'Replication Weight', min: 0, max: 1, step: 0.05, description: 'How much independent replication counts toward a claim standing.' },
  { key: 'highContestationConsensusMax', label: 'Contestation: Consensus Ceiling', min: 0, max: 1, step: 0.05, description: 'At or below this consensus ratio, a claim counts as contested when dissent is rigorous.' },
  { key: 'highContestationDissentRigorMin', label: 'Contestation: Dissent Rigor Floor', min: 0, max: 1, step: 0.05, description: 'At or above this dissent rigor, dissent counts as rigorous for the contestation test.' },
  { key: 'quarantineIndependenceMax', label: 'Quarantine: Independence Ceiling', min: 0, max: 1, step: 0.05, description: 'An undisclosed financial conflict with independence at or below this level quarantines the claim.' },
]);

export const BADGE_LEGEND = Object.freeze([
  { id: 'verified-provenance', label: 'Verified Provenance', tone: 'green' },
  { id: 'unverified-provenance', label: 'Unverified Provenance', tone: 'amber' },
  { id: 'high-contestation', label: 'High Contestation', tone: 'orange' },
  { id: 'conflict-disclosed', label: 'Undisclosed Conflict', tone: 'orange' },
  { id: 'quarantined-review', label: 'Quarantined — Needs Review', tone: 'red' },
  { id: 'blocked-integrity', label: 'Blocked — Integrity Failure', tone: 'red' },
]);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** One guard badge chip, the same markup wherever a badge is shown. */
export function badgeChipHtml(badge) {
  const tone = ['green', 'amber', 'orange', 'red'].includes(badge?.tone) ? badge.tone : 'amber';
  return `<span class="prov-badge prov-badge-${tone}" data-badge="${esc(badge?.id)}" title="${esc(badge?.detail ?? badge?.label ?? '')}">${esc(badge?.label ?? '')}</span>`;
}

export function badgeLegendHtml() {
  return BADGE_LEGEND.map((b) => badgeChipHtml(b)).join(' ');
}

/** The seven weighting sliders for a profile's current values. */
export function slidersHtml(profile) {
  return WEIGHTING_SLIDERS.map((s) => {
    const value = typeof profile?.[s.key] === 'number' ? profile[s.key] : 1;
    return `<label class="row prov-slider-row"><span>${esc(s.label)}</span>`
      + `<input type="range" class="prov-slider" data-prov-key="${esc(s.key)}" min="${s.min}" max="${s.max}" step="${s.step}" value="${value}" aria-label="${esc(s.label)}">`
      + `<output class="prov-slider-value">${Number(value).toFixed(2)}</output></label>`
      + `<p class="muted sm prov-slider-desc">${esc(s.description)}</p>`;
  }).join('');
}

export function profileFromSliders(root) {
  const profile = {};
  for (const input of root.querySelectorAll('.prov-slider')) {
    profile[input.dataset.provKey] = Number(input.value);
  }
  return profile;
}

/**
 * Wire the panel: load the tenant's payload, render, and save on change.
 * api: (method, body?) => Promise<json> for /api/admin/provenance/profile.
 */
export function initProvenancePanel({ root, api }) {
  if (!root || typeof api !== 'function') return;
  const status = root.querySelector('#prov-status');
  const slidersHost = root.querySelector('#prov-sliders');
  const legendHost = root.querySelector('#prov-badges');
  if (legendHost) legendHost.innerHTML = badgeLegendHtml();
  let saveTimer = null;

  const render = (payload) => { if (slidersHost) slidersHost.innerHTML = slidersHtml(payload?.profile ?? {}); bind(); };
  const bind = () => {
    for (const input of root.querySelectorAll('.prov-slider')) {
      input.addEventListener('input', () => {
        const out = input.parentElement.querySelector('.prov-slider-value');
        if (out) out.textContent = Number(input.value).toFixed(2);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 400);
      });
    }
  };
  const save = async () => {
    if (status) status.textContent = 'Saving…';
    try {
      const saved = await api('PUT', { profile: profileFromSliders(root) });
      if (status) status.textContent = saved?.source === 'saved' ? 'Saved. Profile Sync will carry this to your devices.' : 'Saved.';
    } catch {
      if (status) status.textContent = 'Save failed — your last saved profile still stands.';
    }
  };

  (async () => {
    try {
      const read = await api('GET');
      render(read?.payload);
      if (status) status.textContent = read?.source === 'saved' ? 'Your saved weighting profile.' : 'The default weighting profile — move a slider to make it yours.';
    } catch {
      render(null);
      if (status) status.textContent = 'Could not load your profile — showing the defaults.';
    }
  })();
}
