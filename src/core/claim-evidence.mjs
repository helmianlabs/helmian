// CLAIM EVIDENCE — the production caller the provenance machinery
// (src/core/provenance-verification.mjs, Milestone 1) was built for.
//
// Milestone 1 shipped the evaluation core and the pre-response hooks,
// but nothing in the live product assembled the claims they evaluate:
// the agent loop could run verification only when a caller handed it
// structured claim evidence, and no caller did. This module is that
// assembly, built from what a turn actually consulted:
//
//   - every source a turn touched becomes a ProvenanceRecord (its
//     text hashed at assembly, its publisher the domain it came
//     from, its signature honestly 'not-checked' — a fetched page is
//     never signature-verified, and this builder does not pretend
//     otherwise, so its record carries the Unverified Provenance
//     flag and the answer says so);
//   - sources are grouped BY ORIGIN before anything is counted
//     (the anti-sybil weighting, shared with the investigator's
//     dossier scoring): copies of one origin — the same syndicated
//     text, the same author on the same domain family, the same
//     canonical address — count ONCE, however many times they
//     repeat; a group's weight is discounted by its history score
//     when one is known and halved when the origin is brand new;
//   - the reply's own sentences become the claims: a sentence a
//     consulted source supports carries that source's record and a
//     contestation vector weighted by independent origins; a
//     sentence nothing supports carries no record at all, so the
//     guardrail core labels it instead of passing it silently.
//
// Dissent is deliberately NOT scored here: this builder detects no
// contradiction, so dissentRigor is 0 and high-contestation never
// triggers from it. Contested-claim scoring lives with the
// investigator (src/core/provenance-investigator.mjs), which owns
// stance-bearing evidence.

import { createHash } from 'node:crypto';
import {
  createProvenanceRecord,
  createContestationVector,
  isUnverifiedProvenance,
} from './provenance-verification.mjs';

const MAX_CLAIMS = 12;
const MAX_SOURCES = 20;
const SUPPORT_OVERLAP = 0.22;
const SYNDICATION_OVERLAP = 0.6;
const NEW_ORIGIN_MS = 24 * 60 * 60 * 1000;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'as',
  'at', 'by', 'from', 'has', 'have', 'had', 'will', 'would', 'can', 'could',
  'should', 'than', 'then', 'so', 'if', 'when', 'which', 'who', 'what', 'how',
]);

export function domainOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
}

const SECOND_LEVEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'com.au', 'net.au', 'co.nz', 'com.br', 'co.jp', 'com.cn', 'co.in']);

/** The registrable family of a hostname: bbc.co.uk and news.bbc.co.uk are one family. */
export function domainFamilyOf(hostname) {
  const parts = String(hostname ?? '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return SECOND_LEVEL_SUFFIXES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

function contentWords(text) {
  const words = new Set();
  for (const word of String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 3 && !STOPWORDS.has(word)) words.add(word);
  }
  return words;
}

function shingles(text) {
  const words = String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const set = new Set();
  for (let i = 0; i + 4 < words.length; i += 1) set.add(words.slice(i, i + 5).join(' '));
  return set;
}

function overlapRatio(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function sha256Hex(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * Group sources by origin. Two sources are the same origin when any
 * of these hold: the same canonical address; near-identical text
 * (a syndicated copy, overlap at or above SYNDICATION_OVERLAP of
 * their 5-word shingles); or the same named author on the same
 * domain family. A group counts once in every weighting below.
 *
 * A group's weight: 1, scaled by its best known history score
 * (0.25 + 0.75 × history) when any member carries one, and halved
 * when every member's origin is newer than NEW_ORIGIN_MS — a source
 * created yesterday has not earned a full vote yet.
 */
export function groupSourcesByOrigin(sources = [], { now = new Date() } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const shingleSets = list.map((s) => shingles(s?.text ?? ''));
  const textHashes = list.map((s) => sha256Hex(String(s?.text ?? '').trim().toLowerCase()));
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i] ?? {}; const b = list[j] ?? {};
      const sameAddress = a.url && b.url && String(a.url) === String(b.url);
      const bothHaveText = String(a.text ?? '').trim() !== '' && String(b.text ?? '').trim() !== '';
      const sameText = bothHaveText && (textHashes[i] === textHashes[j] || overlapRatio(shingleSets[i], shingleSets[j]) >= SYNDICATION_OVERLAP);
      const sameAuthor = a.author && b.author
        && String(a.author).trim().toLowerCase() === String(b.author).trim().toLowerCase()
        && domainFamilyOf(domainOf(a.url)) === domainFamilyOf(domainOf(b.url));
      if (sameAddress || sameText || sameAuthor) union(i, j);
    }
  }
  const byRoot = new Map();
  list.forEach((source, i) => {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(i);
  });
  const nowMs = new Date(now).getTime();
  return [...byRoot.values()].map((members) => {
    const histories = members.map((i) => list[i]?.historyScore).filter((v) => Number.isFinite(v));
    let weight = histories.length ? 0.25 + 0.75 * Math.max(...histories) : 1;
    const ages = members.map((i) => Date.parse(list[i]?.createdAt ?? '')).filter(Number.isFinite);
    if (ages.length === members.length && ages.every((t) => nowMs - t < NEW_ORIGIN_MS)) weight *= 0.5;
    const first = list[members[0]] ?? {};
    return {
      key: domainFamilyOf(domainOf(first.url)) || String(first.publisher ?? 'unknown'),
      members,
      weight,
      publisher: first.publisher || domainOf(first.url) || '',
      url: first.url ?? '',
    };
  });
}

function splitSentences(text) {
  return String(text ?? '')
    .replace(/^#{1,6}\s+/gm, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[-*•]\s+/, '').trim())
    .filter((s) => s.length >= 30);
}

/**
 * Assemble one turn's claim evidence.
 *
 * @param {object} input
 * @param {string} input.text     the reply about to be delivered
 * @param {Array}  input.sources  [{url, text, publisher?, author?, historyScore?, createdAt?}]
 * @param {Date}   [input.now]
 * @returns {{claims: Array, records: Array, groups: Array,
 *            citations: Array, totals: {sources: number, groups: number, groupWeight: number}}}
 */
export function buildTurnClaims({ text, sources = [], now = new Date() } = {}) {
  const consulted = (Array.isArray(sources) ? sources : []).filter((s) => s && s.url).slice(0, MAX_SOURCES);
  const records = consulted.map((source, i) => createProvenanceRecord({
    recordId: `src-${i + 1}`,
    sourceUrl: String(source.url),
    sourceHash: sha256Hex(source.text ?? ''),
    retrievedAt: new Date(now).toISOString(),
    signatureStatus: 'not-checked',
    attributionStatus: source.publisher || domainOf(source.url) ? 'publisher-only' : 'unknown',
    publisher: source.publisher || domainOf(source.url),
    author: source.author || '',
  }, { now }));
  const groups = groupSourcesByOrigin(consulted, { now });
  const groupOfSource = new Map();
  groups.forEach((group, gi) => group.members.forEach((si) => groupOfSource.set(si, gi)));
  const totalGroupWeight = groups.reduce((sum, g) => sum + g.weight, 0);
  const sourceWords = consulted.map((s) => contentWords(s.text ?? ''));

  const claims = [];
  const citations = [];
  for (const sentence of splitSentences(text)) {
    if (claims.length >= MAX_CLAIMS) break;
    const words = contentWords(sentence);
    if (words.size < 4) continue;
    let best = -1; let bestOverlap = 0;
    const supportingGroups = new Set();
    consulted.forEach((source, si) => {
      let shared = 0;
      for (const word of words) if (sourceWords[si].has(word)) shared += 1;
      const ratio = shared / words.size;
      if (ratio >= SUPPORT_OVERLAP) {
        supportingGroups.add(groupOfSource.get(si));
        if (ratio > bestOverlap) { bestOverlap = ratio; best = si; }
      }
    });
    const claimId = `c${claims.length + 1}`;
    if (best < 0) {
      claims.push({ claimId, text: sentence, provenanceRecord: null, contestationVector: null });
      continue;
    }
    const supportWeight = [...supportingGroups].reduce((sum, gi) => sum + groups[gi].weight, 0);
    const share = totalGroupWeight ? supportWeight / totalGroupWeight : 0;
    const record = records[best];
    const vector = createContestationVector({
      provenanceScore: isUnverifiedProvenance(record) ? 0.35 : 0.85,
      independenceScore: share,
      consensusRatio: share,
      dissentRigor: 0,
    });
    claims.push({ claimId, text: sentence, provenanceRecord: record, contestationVector: vector });
    citations.push({
      claimId,
      sourceUrl: String(consulted[best].url),
      publisher: record.publisher || domainOf(consulted[best].url),
      groupWeight: totalGroupWeight ? groups[groupOfSource.get(best)].weight / totalGroupWeight : 0,
    });
  }
  return {
    claims,
    records,
    groups: groups.map((g) => ({ key: g.key, weight: g.weight, publisher: g.publisher, url: g.url, copies: g.members.length })),
    citations,
    totals: { sources: consulted.length, groups: groups.length, groupWeight: totalGroupWeight },
  };
}

/**
 * The who-said-it block a delivered answer carries when its turn
 * consulted sources: one line per independent origin (copies of one
 * origin appear once, with their count), each with its share of the
 * total independent weight, and the verification outcome in plain
 * words. Returns '' when nothing was consulted.
 */
export function renderVerificationFooter({ claims = [], groups = [], totals = {}, verdict = null } = {}) {
  if (!totals.sources) return '';
  const total = totals.groupWeight || 0;
  const lines = groups.map((group) => {
    const share = total ? (group.weight / total).toFixed(2) : '0.00';
    const copies = group.copies > 1 ? ` (${group.copies} copies, counted once)` : '';
    return `• ${group.publisher || group.key} — ${group.url} (independent weight ${share})${copies}`;
  });
  const sourced = claims.filter((c) => c.provenanceRecord).length;
  const action = verdict?.action ?? 'annotate';
  const summary = action === 'allow'
    ? 'Verification: every claim above carries a verified source.'
    : `Verification: ${action} — ${sourced} of ${claims.length} claims carry a named source; the rest are marked where they stand.`;
  return `Sources for this answer (weighted by independence — copies of one origin count once):\n${lines.join('\n')}\n${summary}`;
}
