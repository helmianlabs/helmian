// The live lookup harness (Scribe 1154, bite 3): registry-shaped responses
// in, honest evidence out. Classification is title-led and conservative;
// unanswerable categories return nothing and become named gaps downstream.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveLookup, claimKeywords } from '../src/agent/provenance-live-lookup.mjs';
import { runInvestigation } from '../src/core/provenance-investigator.mjs';
import { createProvenanceRecord } from '../src/core/provenance-verification.mjs';

const CLAIM = {
  claimId: 'mmr-1998',
  claimText: 'The 1998 Wakefield study linked MMR vaccination to autism in children',
  authors: ['Wakefield AJ'],
  institutions: ['Royal Free Hospital'],
  provenanceRecord: createProvenanceRecord({
    recordId: 'mmr-source', sourceUrl: 'https://doi.org/10.1016/S0140-6736(97)11096-0',
    signatureStatus: 'absent', attributionStatus: 'verified', publisher: 'The Lancet', author: 'Wakefield AJ',
  }),
};

function epmc(results) {
  return { resultList: { result: results } };
}

function fetchStub(routes) {
  return async (url) => {
    for (const [match, payload] of routes) {
      if (String(url).includes(match)) {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        return { ok: true, status: 200, text: async () => text, arrayBuffer: async () => Buffer.from(text) };
      }
    }
    return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  };
}

const RETRACTION_HIT = {
  id: '20210001', pmid: '20210001', doi: '10.1016/S0140-6736(10)60175-5',
  title: 'Retraction: Ileal-lymphoid-nodular hyperplasia and pervasive developmental disorder',
  pubYear: '2010', journalInfo: { journal: { title: 'The Lancet' } },
};

test('keywords drop stopwords and keep the claim\'s substance', () => {
  assert.deepEqual(claimKeywords(CLAIM.claimText), ['1998', 'wakefield', 'mmr', 'vaccination', 'autism', 'children']);
});

test('a retraction-titled registry record becomes disputes evidence with its own provenance record', async () => {
  const lookup = createLiveLookup({
    claim: CLAIM,
    fetchImpl: fetchStub([
      ['api.crossref.org/works/10.1016', { message: { 'update-to': [{ type: 'retraction', DOI: '10.1016/S0140-6736(10)60175-5' }] } }],
      ['europepmc', epmc([RETRACTION_HIT])],
    ]),
  });
  const items = await lookup({ queryId: 'q9', category: 'retraction', subjectKind: 'claim', subject: 'mmr-1998' });
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.stance === 'disputes'));
  assert.ok(items[0].provenanceRecord.sourceHash, 'the registry record itself is fingerprinted');
  assert.equal(items[0].provenanceRecord.unverifiedProvenance, true);
});

test('a retraction NOTICE whose update-to points at the claim source is disputes evidence', async () => {
  const lookup = createLiveLookup({
    claim: CLAIM,
    fetchImpl: fetchStub([
      ['query.bibliographic', { message: { items: [{ DOI: '10.1016/S0140-6736(10)60175-4', title: ['Retraction—Ileal-lymphoid-nodular hyperplasia'], 'update-to': [{ DOI: '10.1016/S0140-6736(97)11096-0', type: 'retraction', source: 'retraction-watch' }] }] } }],
      ['europepmc', epmc([])],
    ]),
  });
  const items = await lookup({ queryId: 'q9', category: 'retraction', subjectKind: 'claim', subject: 'mmr-1998' });
  assert.equal(items.length, 1);
  assert.equal(items[0].evidenceId, 'live-retraction-notice-10.1016/S0140-6736(10)60175-4');
  assert.match(items[0].summary, /records a retraction of 10\.1016\/S0140-6736\(97\)11096-0/);
});

test('a non-retraction search hit is never upgraded into a retraction', async () => {
  const lookup = createLiveLookup({
    claim: CLAIM,
    fetchImpl: fetchStub([['europepmc', epmc([{ ...RETRACTION_HIT, title: 'MMR vaccination trends in England' }])]]),
  });
  const items = await lookup({ queryId: 'q9', category: 'retraction', subjectKind: 'claim', subject: 'mmr-1998' });
  assert.equal(items.length, 0);
});

test('lobbying has no wired road: the lookup throws, which the core records as a named gap', async () => {
  const lookup = createLiveLookup({ claim: CLAIM, fetchImpl: fetchStub([]) });
  await assert.rejects(
    () => lookup({ queryId: 'q3', category: 'lobbying', subjectKind: 'author', subject: 'Wakefield AJ' }),
    /no live road wired for category lobbying/,
  );
});

test('END TO END: a live-shaped investigation yields a dossier with disputes, a vector, and named gaps', async () => {
  const lookup = createLiveLookup({
    claim: CLAIM,
    fetchImpl: fetchStub([
      ['api.crossref.org/works/10.1016', { message: { 'update-to': [{ type: 'retraction', DOI: '10.1016/S0140-6736(10)60175-5' }] } }],
      ['query.bibliographic', { message: { items: [{ DOI: '10.1016/S0140-6736(97)11096-0', title: ['Ileal-lymphoid-nodular hyperplasia'], type: 'journal-article', issued: { 'date-parts': [[1998]] } }] } }],
      ['TITLE%3A%22retraction%22', epmc([RETRACTION_HIT])],
      ['europepmc', epmc([])],
    ]),
  });
  const dossier = await runInvestigation({ claim: CLAIM, lookup });
  assert.ok(dossier.evidence.some((e) => e.category === 'retraction' && e.stance === 'disputes'));
  assert.ok(dossier.contestationVector.consensusRatio < 0.5, 'retraction evidence drags consensus down');
  assert.ok(dossier.gaps.some((g) => g.category === 'lobbying' && /no live road/.test(g.reason)), 'the unwired category is a named gap');
});
