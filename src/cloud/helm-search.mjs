// Helm's search piece (fix programme bite H5, DESIGN 3.3):
// the two tools the Helm design promised — search_web and
// read_page — behind ONE provider interface, and the citation
// assembly that turns retrieved pages into Helm's answer.
//
// The provider decision DESIGN 3.3 left open inside this bite
// is named here, on the free-tier design's provider evidence
// (helm-free-tier/DESIGN.md section 3): PRIMARY Tavily (one
// search call returns ranked results with cleaned page text;
// extract reads a page the same way), FALLBACK Exa (its own
// index, so an outage or a quality miss fails over to genuinely
// different results). No other provider sits behind the
// interface. The seat path's web search is a per-seat toggle
// the seat's own model honours on the runner side; it is not
// callable from the cloud path, so the design's reuse default
// does not apply and the named providers carry the road.
//
// Keys come from the environment (TAVILY_API_KEY, EXA_API_KEY)
// — the cloud path's configuration road, the ABLY_API_KEY /
// CLERK_SECRET_KEY pattern — never from code. With NO key
// configured, createHelmSearch returns null and Helm's road
// is exactly what it was before this bite: the records answer,
// or the honest availability line and a miss filing. The room
// never breaks for want of a key.
//
// Terms posture, read at the clause level on 2026-11-16 (the
// free-tier design's one UNVERIFIED clause, closed by this
// bite; the full reading is in bite H5's REPORT.md):
//   - Tavily's Platform Terms (tavily.com/terms) bar nothing
//     about keeping Output: the restrictions bind the Services
//     themselves, section 9 leaves Customer Input with the
//     customer, and no clause prohibits storing results or
//     filing a composed answer. Tavily answers are therefore
//     answered from AND filed (mayFileAnswers: true).
//   - Exa's Terms of Service (Exa_Labs_Terms_of_Service.pdf)
//     section 4.2(a) bars copying, reproducing, or creating
//     derivative works from information obtained through the
//     Services beyond a browser-cache exception, and no clause
//     grants a storage right for API results. Exa answers are
//     therefore answered from but NOT filed
//     (mayFileAnswers: false): the answer posts in the channel
//     and leaves no entry in shared memory.
//
// Bounds, per question: each configured provider is tried at
// most once, in order, so a question rents at most two
// searches; at most HELM_SEARCH_MAX_READS pages are read.
// Those are the free-tier design's per-question caps (section
// 2.3), adopted here as this bite's named choice where the
// programme design states no cap of its own. Every call is
// timeout-bounded and the composite never throws: a provider
// error or an empty result moves to the next provider, and
// when no provider serves, searchWeb returns null and the
// caller degrades to the availability line — never a hang,
// never an invented answer.

import { kbCandidateTriggers, kbFindWords } from './envoy-librarian.mjs';

export const HELM_SEARCH_MAX_RESULTS = 5;
export const HELM_SEARCH_MAX_READS = 3;
export const HELM_SEARCH_TIMEOUT_MS = 10_000;

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';
const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const EXA_CONTENTS_URL = 'https://api.exa.ai/contents';

// One bounded JSON POST. Throws on a transport failure, a
// timeout, or a non-2xx answer; the providers' callers treat a
// throw as "this provider did not serve" and move on.
async function postJson({ fetchImpl, url, headers, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`search provider answered HTTP ${response?.status ?? 'unknown'}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const resultRow = (r) => ({
  title: String(r?.title ?? ''),
  url: String(r?.url ?? ''),
  content: String(r?.content ?? r?.text ?? ''),
});

/**
 * The Tavily provider: search returns ranked results with a
 * cleaned content passage per result; read_page is Tavily
 * Extract, the same cleaned text for one page. Helm does NOT
 * ask Tavily for its generated answer (include_answer stays
 * off): Helm's answer is composed from retrieved page text,
 * never from a provider's prose. Returns null with no key.
 */
export function tavilyHelmSearchProvider({ apiKey, fetchImpl = fetch, timeoutMs = HELM_SEARCH_TIMEOUT_MS } = {}) {
  if (!apiKey) return null;
  const headers = { authorization: `Bearer ${apiKey}` };
  return Object.freeze({
    name: 'tavily',
    mayFileAnswers: true,
    async searchWeb(query) {
      const data = await postJson({
        fetchImpl, url: TAVILY_SEARCH_URL, headers, timeoutMs,
        body: { query: String(query ?? ''), search_depth: 'basic', max_results: HELM_SEARCH_MAX_RESULTS, include_answer: false, include_raw_content: false },
      });
      return (Array.isArray(data?.results) ? data.results : []).map(resultRow).filter((r) => r.url);
    },
    async readPage(url) {
      const data = await postJson({
        fetchImpl, url: TAVILY_EXTRACT_URL, headers, timeoutMs,
        body: { urls: [String(url ?? '')], extract_depth: 'basic' },
      });
      const rows = Array.isArray(data?.results) ? data.results : [];
      const hit = rows.find((r) => String(r?.url ?? '') === String(url ?? '')) ?? rows[0];
      const text = String(hit?.raw_content ?? '').trim();
      return text ? { title: '', url: String(url ?? ''), text } : null;
    },
  });
}

/**
 * The Exa provider: search with contents returns each result's
 * page text inline; read_page is the Contents endpoint for one
 * page. Returns null with no key.
 */
export function exaHelmSearchProvider({ apiKey, fetchImpl = fetch, timeoutMs = HELM_SEARCH_TIMEOUT_MS } = {}) {
  if (!apiKey) return null;
  const headers = { 'x-api-key': apiKey };
  return Object.freeze({
    name: 'exa',
    mayFileAnswers: false,
    async searchWeb(query) {
      const data = await postJson({
        fetchImpl, url: EXA_SEARCH_URL, headers, timeoutMs,
        body: { query: String(query ?? ''), type: 'auto', numResults: HELM_SEARCH_MAX_RESULTS, contents: { text: { maxCharacters: 6000 } } },
      });
      return (Array.isArray(data?.results) ? data.results : []).map(resultRow).filter((r) => r.url);
    },
    async readPage(url) {
      const data = await postJson({
        fetchImpl, url: EXA_CONTENTS_URL, headers, timeoutMs,
        body: { urls: [String(url ?? '')], text: { maxCharacters: 12000 } },
      });
      const rows = Array.isArray(data?.results) ? data.results : [];
      const hit = rows.find((r) => String(r?.url ?? '') === String(url ?? '')) ?? rows[0];
      const text = String(hit?.text ?? '').trim();
      return text ? { title: String(hit?.title ?? ''), url: String(url ?? ''), text } : null;
    },
  });
}

/**
 * The one interface the answerer talks to: the configured
 * providers in order (Tavily, then Exa), or null when neither
 * key is configured. searchWeb tries each provider once — a
 * throw or an empty result set moves to the next — and returns
 * the serving provider's name, its filing posture, its results,
 * and a readPage bound to that same provider, so a page is
 * always read through the door that found it. Returns null
 * when no provider serves; never throws.
 */
export function createHelmSearch({
  tavilyKey = process.env.TAVILY_API_KEY,
  exaKey = process.env.EXA_API_KEY,
  fetchImpl = fetch,
  timeoutMs = HELM_SEARCH_TIMEOUT_MS,
} = {}) {
  const providers = [
    tavilyHelmSearchProvider({ apiKey: tavilyKey, fetchImpl, timeoutMs }),
    exaHelmSearchProvider({ apiKey: exaKey, fetchImpl, timeoutMs }),
  ].filter(Boolean);
  if (!providers.length) return null;
  return Object.freeze({
    providers: providers.map((p) => p.name),
    async searchWeb(query) {
      for (const provider of providers) {
        let results = null;
        try {
          results = await provider.searchWeb(query);
        } catch {
          results = null;
        }
        if (Array.isArray(results) && results.length) {
          return {
            provider: provider.name,
            mayFileAnswers: provider.mayFileAnswers === true,
            results,
            readPage: (url) => provider.readPage(url),
          };
        }
      }
      return null;
    },
  });
}

// ------------------------------------------------------------ the citation assembly

// The answer's bounds: excerpts from at most two pages, each
// excerpt capped, and the whole body — citations included —
// capped so the filed copy (the Librarian's entry bound) can
// hold the answer whole: what recall later quotes is the
// answer that was posted, citations and all.
export const HELM_SEARCH_EXCERPT_MAX_CHARS = 380;
export const HELM_SEARCH_BODY_MAX_CHARS = 950;
const HELM_SEARCH_EXCERPT_PAGES = 2;

// Cut a passage to the cap at a sentence end when one lands
// past the halfway mark, else at a word boundary: an excerpt
// is a quote, and a quote ends at a boundary, never mid-word.
function boundExcerpt(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= HELM_SEARCH_EXCERPT_MAX_CHARS) return flat;
  const cut = flat.slice(0, HELM_SEARCH_EXCERPT_MAX_CHARS);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence > HELM_SEARCH_EXCERPT_MAX_CHARS / 2) return cut.slice(0, sentence + 1).trim();
  const word = cut.lastIndexOf(' ');
  return (word > 0 ? cut.slice(0, word) : cut).trim();
}

// The most on-question passage of one page: its paragraphs
// scored by the question's own topic words (the Librarian's
// matcher, word-bounded), the best score winning, ties going
// to the earliest paragraph. With no scoring words, or no
// paragraph scoring at all, the lead passage stands. Every
// character of the excerpt is the page's own text.
function bestExcerpt(text, words) {
  const paragraphs = String(text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 30);
  const candidates = paragraphs.length ? paragraphs : [String(text ?? '').replace(/\s+/g, ' ').trim()].filter(Boolean);
  let best = null;
  for (const paragraph of candidates) {
    const score = words.length ? kbFindWords(paragraph, words).length : 0;
    if (!best || score > best.score) best = { text: paragraph, score };
  }
  return best ? boundExcerpt(best.text) : '';
}

/**
 * Compose Helm's search answer from the pages read: an
 * excerpt per page (up to two), then the citations naming
 * EVERY page read — title and URL, in read order. Pure over
 * the retrieved pages ({ title, url, text }); nothing enters
 * the body but the pages' own words and their names. Returns
 * { body, sources } or null when no page carries usable text,
 * or when the citations themselves cannot fit the body bound
 * (an answer that cannot name its sources is not posted as a
 * search answer at all).
 */
export function composeHelmSearchAnswer({ question, pages } = {}) {
  const usable = (pages ?? []).filter((p) => p && String(p.url ?? '') && String(p.text ?? '').trim());
  if (!usable.length) return null;
  const words = kbCandidateTriggers(question);
  const sources = usable.map((p) => ({ title: String(p.title ?? '').trim() || String(p.url), url: String(p.url) }));
  const citationLine = `Sources: ${sources.map((s) => `${s.title} (${s.url})`).join('; ')}`;
  const excerpts = [];
  for (const page of usable.slice(0, HELM_SEARCH_EXCERPT_PAGES)) {
    const excerpt = bestExcerpt(page.text, words);
    if (excerpt) excerpts.push(excerpt);
  }
  if (!excerpts.length) return null;
  let body = [...excerpts, citationLine].join('\n\n');
  if (body.length > HELM_SEARCH_BODY_MAX_CHARS && excerpts.length > 1) {
    body = [excerpts[0], citationLine].join('\n\n');
  }
  if (body.length > HELM_SEARCH_BODY_MAX_CHARS) return null;
  return { body, sources };
}
