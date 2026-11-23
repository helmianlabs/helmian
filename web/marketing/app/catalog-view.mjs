// Connector catalog view (connector-catalog brief §(e), bite 2):
// the per-seat Connectors view, read-only. Cards render from the
// catalog service (GET /api/admin/connector-catalog) — Helmian's own
// mirror of the public MCP Registry, curated — and each featured
// card's tool list is fetched live from that server at view time
// (GET /api/admin/connector-catalog/tools), so what a card promises
// is what its server answers right now, not a stored claim.
//
// This bite connects nothing: there is no Connect button and no
// credential handling here. A card shows what the service is, where
// its source lives, how it would sign a person in, and the tools it
// brings — fetched fresh, or an honest line when the server asks
// for a sign-in first or does not answer.
//
// The model functions are pure (unit tested); initCatalogPanel owns
// the DOM and the fetches.

// The seats the catalog read accepts — the room's live seats, the
// same list the server validates against (connector-catalog.mjs
// LIVE_SEATS). The featured shelf is universal today (the curation
// layer stocks every pick on every seat), so the seat pick changes
// whose view this is, not which featured cards stand on it — the
// per-seat part lands when connections do (bite 3).
export const CATALOG_SEATS = Object.freeze([
  'claude', 'chatgpt', 'grok', 'gemini', 'mistral', 'groq', 'nvidia',
  'openrouter', 'cloudflare', 'qwen', 'muse', 'maestro', 'helm', 'owner',
]);

const AUTH_WORDS = Object.freeze({ oauth: 'Signs you in at the service', api_key: 'API key', none: 'No sign-in' });

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function seatLabel(seatId) {
  return seatId ? seatId.charAt(0).toUpperCase() + seatId.slice(1) : '';
}

/** The header line over the shelves: what the catalog holds, counted. */
export function catalogHeaderModel(read) {
  const curated = read?.totals?.curated ?? 0;
  const listings = read?.totals?.listings ?? 0;
  return {
    curated,
    listings,
    line: `${curated.toLocaleString('en-US')} curated listings, from ${listings.toLocaleString('en-US')} the registry carries — each one source-linked, from a real publisher, its endpoint answering when last checked.`,
  };
}

export function featuredCardHtml(card) {
  const auth = AUTH_WORDS[card.authMode] ?? 'Sign-in';
  const source = card.sourceUrl
    ? `<a class="cat-source" href="${esc(card.sourceUrl)}" target="_blank" rel="noopener">Source</a>`
    : '';
  const state = !card.inCatalog
    ? 'Named on the featured shelf; the registry mirror has no row for it yet.'
    : card.curated
      ? 'Curated in the registry mirror.'
      : 'On the featured shelf by name; the nightly funnel leaves its mirror row uncurated.';
  return `<article class="cat-card" data-catalog-card="${esc(card.entryId)}">
    <header class="cat-card-head"><h4>${esc(card.name)}</h4><span class="cat-chip">Featured</span></header>
    <p class="cat-vendor">${esc(card.vendorName)}</p>
    <p class="cat-line">${esc(card.oneLiner)}</p>
    <p class="cat-meta">${esc(auth)} · Community listing${card.version ? ` · v${esc(card.version)}` : ''}${card.endpointHost ? ` · ${esc(card.endpointHost)}` : ''}</p>
    <p class="cat-state">${esc(state)}</p>
    <div class="cat-tools" data-tools-for="${esc(card.registryName)}"><p class="muted sm">Checking its tools…</p></div>
    ${source}
  </article>`;
}

export function browseCardHtml(card) {
  const source = card.sourceUrl
    ? `<a class="cat-source" href="${esc(card.sourceUrl)}" target="_blank" rel="noopener">Source</a>`
    : '';
  const description = String(card.description ?? '').slice(0, 180);
  return `<article class="cat-card" data-catalog-card="${esc(card.registryName)}">
    <header class="cat-card-head"><h4>${esc(card.name)}</h4></header>
    <p class="cat-vendor">${esc(card.publisher)}</p>
    ${description ? `<p class="cat-line">${esc(description)}</p>` : ''}
    <p class="cat-meta">Community listing${card.version ? ` · v${esc(card.version)}` : ''}${card.endpointHost ? ` · ${esc(card.endpointHost)}` : ''}</p>
    ${source}
  </article>`;
}

/** What a featured card's tool area shows once the live fetch lands. */
export function toolsResultHtml(result) {
  if (!result || result.state === 'unreachable') return '<p class="muted sm">Its server did not answer just now.</p>';
  if (result.state === 'auth') return '<p class="muted sm">Sign-in required — its tools are not public until a person connects.</p>';
  if (result.state === 'error') return '<p class="muted sm">Its server answered, but not as a connector.</p>';
  const tools = Array.isArray(result.tools) ? result.tools : [];
  if (!tools.length) return '<p class="muted sm">Its server answered with no tools.</p>';
  const items = tools.map((tool) => `<li title="${esc(tool.description ?? '')}">${esc(tool.name)}</li>`).join('');
  return `<p class="cat-tools-count">${tools.length} tool${tools.length === 1 ? '' : 's'}, fetched live just now:</p><ul class="cat-tools-list">${items}</ul>`;
}

export function catalogPanelHtml(read, seatId) {
  const header = catalogHeaderModel(read);
  const options = CATALOG_SEATS.map((seat) => `<option value="${esc(seat)}"${seat === seatId ? ' selected' : ''}>${esc(seatLabel(seat))}</option>`).join('');
  const featured = (read?.featured ?? []).map(featuredCardHtml).join('');
  const browse = (read?.browse ?? []).map(browseCardHtml).join('');
  return `<div class="cat-head">
      <p class="muted sm">${esc(header.line)}</p>
      <label class="cat-seat">Connectors for <select id="catalog-seat">${options}</select></label>
    </div>
    <section class="int-section"><h3 class="int-head">Featured</h3><div class="int-grid">${featured}</div></section>
    <section class="int-section"><h3 class="int-head">From the registry mirror</h3><div class="int-grid">${browse}</div></section>`;
}

/**
 * Render the panel into root and run the live tool fetches for the
 * featured cards. fetchJson(path) is the app's api() read. Changing
 * the seat re-renders the whole panel for that seat.
 */
export function initCatalogPanel({ root, fetchJson }) {
  if (!root) return;
  let seat = 'claude';
  const render = async () => {
    root.innerHTML = '<p class="muted sm">Loading the catalog…</p>';
    let read;
    try {
      read = await fetchJson(`/api/admin/connector-catalog?seat=${encodeURIComponent(seat)}`);
    } catch {
      root.innerHTML = '<p class="muted sm">The catalog did not answer. It is read from Helmian\'s own mirror — nothing here depends on the public registry being up.</p>';
      return;
    }
    root.innerHTML = catalogPanelHtml(read, seat);
    const select = root.querySelector('#catalog-seat');
    if (select) select.onchange = () => { seat = select.value; void render(); };
    for (const area of root.querySelectorAll('[data-tools-for]')) {
      const name = area.getAttribute('data-tools-for');
      fetchJson(`/api/admin/connector-catalog/tools?name=${encodeURIComponent(name)}`)
        .then((result) => { area.innerHTML = toolsResultHtml(result); })
        .catch(() => { area.innerHTML = toolsResultHtml({ state: 'unreachable', tools: [] }); });
    }
  };
  void render();
}
