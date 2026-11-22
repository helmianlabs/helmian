// The live lookup harness for the Sandbox Investigator (Scribe 1154,
// Milestone 2 follow-up): the injected lookup the investigator core runs,
// backed by real public registries instead of recorded answers.
//
// Roads used — all public, keyless, and read-only:
//   - Europe PMC (www.ebi.ac.uk/europepmc) for retractions, rebuttals,
//     replications, author affiliations, and grant/funder records.
//   - Crossref (api.crossref.org) for the primary source record and for
//     retraction relations (update-to) on the claim's own DOI.
// Roads deliberately NOT used: any registry that demands an API key or an
// email registration before it answers (OpenAlex's free tier was exhausted
// and keyed access is a signup, Semantic Scholar rate-limits keyless
// callers) — a sub-query those roads would have answered is left
// unanswered, and the investigator core records it as a named gap. The
// 'lobbying' category has no honest keyless road wired at all: always a
// gap, never a guess.
//
// Classification is conservative and title-led: a record counts as a
// retraction only when its title says so, a rebuttal only when it presents
// as a comment/response on the work, a failed replication only when the
// title says it failed. Everything else that bears on the claim is
// 'context'. The harness never upgrades a search hit into support for a
// claim. Every evidence item carries a Milestone 1 provenance record for
// the registry entry itself: the sha256 of the exact JSON retrieved, the
// retrieval time, signature not-checked — so registry evidence is itself
// flagged Unverified Provenance until a stronger road exists.

import { createHash } from 'node:crypto';

import { createProvenanceRecord } from '../core/provenance-verification.mjs';

const EUROPE_PMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const CROSSREF = 'https://api.crossref.org/works';
const TIMEOUT_MS = 12000;
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 'that', 'this', 'from', 'by', 'is', 'are', 'was', 'were', 'study', 'studies', 'found', 'shows', 'showed', 'link', 'linked', 'links']);

export function claimKeywords(claimText, limit = 6) {
  const words = String(claimText ?? '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, limit);
}

async function getJson(fetchImpl, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res || res.ok === false) return null;
    const text = await res.text();
    try { return { json: JSON.parse(text), raw: text }; } catch { return null; }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function recordFor(url, raw, publisher, now) {
  return createProvenanceRecord({
    recordId: `live-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`,
    sourceUrl: url,
    ...(raw ? { sourceHash: createHash('sha256').update(raw).digest('hex') } : {}),
    signatureStatus: 'not-checked',
    attributionStatus: 'publisher-only',
    publisher,
  }, { now });
}

function epmcSearchUrl(query) {
  return `${EUROPE_PMC}?query=${encodeURIComponent(query)}&format=json&pageSize=5&resultType=core`;
}

/**
 * Build the live lookup for one claim. The returned function answers the
 * investigator's planned sub-queries and returns [] for anything the live
 * roads cannot honestly answer (the core records those as gaps).
 */
export function createLiveLookup({ claim, fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createLiveLookup needs a fetch implementation');
  const keywords = claimKeywords(claim?.claimText).join(' ');
  const kwQuery = keywords || String(claim?.claimText ?? '').slice(0, 80);

  const epmcItems = async (query) => {
    const got = await getJson(fetchImpl, epmcSearchUrl(query));
    return got ? { results: got.json?.resultList?.result ?? [], raw: got.raw } : { results: [], raw: null };
  };

  const titleOf = (r) => String(r?.title ?? '').replace(/<[^>]+>/g, '').trim();
  const urlOf = (r) => (r?.doi ? `https://doi.org/${r.doi}` : (r?.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` : 'https://europepmc.org'));

  return async function liveLookup(subquery) {
    const { category, subject, subjectKind } = subquery;

    if (category === 'retraction') {
      const items = [];
      // The claim's own DOI, if it is one, may carry a retraction relation.
      const sourceUrl = claim?.provenanceRecord?.sourceUrl ?? '';
      const doiMatch = /doi\.org\/(10\.\S+)/i.exec(sourceUrl);
      if (doiMatch) {
        const got = await getJson(fetchImpl, `${CROSSREF}/${encodeURIComponent(doiMatch[1])}`);
        const updates = got?.json?.message?.['update-to'] ?? [];
        for (const u of updates) {
          if (/retract/i.test(String(u?.type ?? ''))) {
            items.push({
              evidenceId: `live-retraction-${u.DOI ?? 'self'}`,
              category, stance: 'disputes',
              summary: `Crossref records a ${u.type} relation on the claim's own source (updated DOI ${u.DOI ?? 'unknown'}).`,
              sourceUrl: `https://doi.org/${doiMatch[1]}`,
              sourcePublisher: 'Crossref',
              provenanceRecord: recordFor(`${CROSSREF}/${doiMatch[1]}`, got.raw, 'Crossref', now),
            });
          }
        }
      }
      // Retraction notices carry the relation on THEIR record, not the
      // original's: a Crossref bibliographic search surfaces the notice,
      // whose update-to array names the retracted DOI with type
      // 'retraction' (sourced from Retraction Watch). A notice whose
      // update-to does not point at this claim's source still counts when
      // its title presents it as the retraction of this work.
      const cr = await getJson(fetchImpl, `${CROSSREF}?query.bibliographic=${encodeURIComponent(claim?.claimText ?? '')}&rows=5`);
      for (const item of cr?.json?.message?.items ?? []) {
        for (const u of item['update-to'] ?? []) {
          if (!/retract/i.test(String(u?.type ?? ''))) continue;
          const pointsAtClaim = doiMatch && u.DOI && String(u.DOI).toLowerCase() === doiMatch[1].toLowerCase();
          const titledAsRetraction = /^retraction/i.test((item.title ?? [])[0] ?? '');
          if (!pointsAtClaim && !titledAsRetraction) continue;
          items.push({
            evidenceId: `live-retraction-notice-${item.DOI ?? 'x'}`,
            category, stance: 'disputes',
            summary: `Retraction notice ${item.DOI ?? ''} ("${(item.title ?? [])[0] ?? 'untitled'}") records a retraction of ${u.DOI ?? 'the source'} (Crossref update-to, source: ${u.source ?? 'publisher'}).`,
            sourceUrl: item.DOI ? `https://doi.org/${item.DOI}` : 'https://crossref.org',
            sourcePublisher: 'Crossref',
            provenanceRecord: recordFor(`https://doi.org/${item.DOI ?? ''}`, cr.raw, 'Crossref', now),
          });
        }
      }
      const { results, raw } = await epmcItems(`(TITLE:"retraction" OR TITLE:"retracted") AND (${kwQuery})`);
      for (const r of results.slice(0, 3)) {
        const title = titleOf(r);
        if (!/retract/i.test(title)) continue;
        items.push({
          evidenceId: `live-retraction-${r.id ?? r.pmid ?? title.slice(0, 24)}`,
          category, stance: 'disputes',
          summary: `Retraction record: "${title}" (${r.journalInfo?.journal?.title ?? 'journal unknown'}, ${r.pubYear ?? 'year unknown'}).`,
          sourceUrl: urlOf(r), sourcePublisher: 'Europe PMC',
          provenanceRecord: recordFor(urlOf(r), raw, 'Europe PMC', now),
        });
      }
      return items;
    }

    if (category === 'rebuttal') {
      const { results, raw } = await epmcItems(`(${kwQuery}) AND (TITLE:"comment" OR TITLE:"response" OR TITLE:"critique")`);
      return results.slice(0, 3).filter((r) => /comment|response|critique/i.test(titleOf(r))).map((r) => ({
        evidenceId: `live-rebuttal-${r.id ?? r.pmid ?? 'x'}`,
        category, stance: 'disputes',
        summary: `Published rebuttal/comment: "${titleOf(r)}" (${r.pubYear ?? 'year unknown'}).`,
        sourceUrl: urlOf(r), sourcePublisher: 'Europe PMC',
        provenanceRecord: recordFor(urlOf(r), raw, 'Europe PMC', now),
      }));
    }

    if (category === 'replication') {
      const { results, raw } = await epmcItems(`(${kwQuery}) AND (TITLE:"replication" OR TITLE:"replicating")`);
      return results.slice(0, 3).filter((r) => /replicat/i.test(titleOf(r))).map((r) => {
        const title = titleOf(r);
        const failed = /fail|unable|could not/i.test(title);
        return {
          evidenceId: `live-replication-${r.id ?? r.pmid ?? 'x'}`,
          category, stance: failed ? 'disputes' : 'context',
          summary: `${failed ? 'Failed replication' : 'Replication record'}: "${title}" (${r.pubYear ?? 'year unknown'}).`,
          sourceUrl: urlOf(r), sourcePublisher: 'Europe PMC',
          provenanceRecord: recordFor(urlOf(r), raw, 'Europe PMC', now),
        };
      });
    }

    if (category === 'primary-source') {
      const got = await getJson(fetchImpl, `${CROSSREF}?query.bibliographic=${encodeURIComponent(claim?.claimText ?? '')}&rows=3`);
      const items = got?.json?.message?.items ?? [];
      const top = items[0];
      if (!top) return [];
      const title = (top.title ?? [])[0] ?? 'untitled';
      return [{
        evidenceId: `live-primary-${top.DOI ?? 'x'}`,
        category, stance: 'context',
        summary: `Primary source record: "${title}" (${top.type ?? 'work'}, ${top.issued?.['date-parts']?.[0]?.[0] ?? 'year unknown'}), DOI ${top.DOI ?? 'unknown'}.`,
        sourceUrl: top.DOI ? `https://doi.org/${top.DOI}` : 'https://crossref.org',
        sourcePublisher: 'Crossref',
        provenanceRecord: recordFor(`https://doi.org/${top.DOI ?? ''}`, got.raw, 'Crossref', now),
      }];
    }

    if (category === 'affiliation' && subject) {
      const { results, raw } = await epmcItems(`AUTH:"${subject}"`);
      const withAffiliation = results.find((r) => r.authorList?.author?.some((a) => a.authorAffiliationDetailsList));
      if (!withAffiliation) return [];
      const aff = withAffiliation.authorList.author
        .flatMap((a) => a.authorAffiliationDetailsList?.authorAffiliationDetails ?? [])
        .map((d) => d.affiliation).filter(Boolean)[0];
      if (!aff) return [];
      return [{
        evidenceId: `live-affiliation-${subquery.queryId}`,
        category, stance: 'context',
        summary: `Europe PMC records ${subject}'s affiliation as: ${aff}.`,
        sourceUrl: urlOf(withAffiliation), sourcePublisher: 'Europe PMC',
        provenanceRecord: recordFor(urlOf(withAffiliation), raw, 'Europe PMC', now),
      }];
    }

    if ((category === 'grant-registry' || category === 'financial-disclosure') && subject) {
      const field = subjectKind === 'author' ? `AUTH:"${subject}"` : `(${subject})`;
      const { results, raw } = await epmcItems(field);
      const grants = [];
      for (const r of results) {
        for (const g of r.grantsList?.grant ?? []) {
          if (g.funder) grants.push({ funder: g.funder, grantId: g.grantId, title: titleOf(r) });
        }
      }
      if (!grants.length) return [];
      const funders = [...new Set(grants.map((g) => g.funder))].slice(0, 4).join(', ');
      return [{
        evidenceId: `live-${category}-${subquery.queryId}`,
        category, stance: 'context',
        summary: `Europe PMC grant records for ${subject} name funders: ${funders} (${grants.length} grant record(s) across the first results).`,
        sourceUrl: 'https://europepmc.org', sourcePublisher: 'Europe PMC',
        financialConflict: null,
        provenanceRecord: recordFor('https://europepmc.org', raw, 'Europe PMC', now),
      }];
    }

    // Lobbying has no honest keyless road wired at all. Throwing is
    // deliberate: the investigator core records a thrown lookup as a
    // NAMED GAP in the dossier, while an empty return would read as
    // "searched and found nothing" — a claim this harness cannot make
    // for a category it never searched.
    throw new Error(`no live road wired for category ${category} (keyless public registries only)`);
  };
}
