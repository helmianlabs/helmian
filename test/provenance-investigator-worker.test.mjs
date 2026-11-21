// The investigator WORKER: the file-in / dossier-out contract, exercised
// in-process and as a real child process. A sub-query with no recorded
// answer must land in the dossier as a named gap — that is the property the
// whole worker design rests on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildInvestigationPlan } from '../src/core/provenance-investigator.mjs';
import {
  createRecordedLookup,
  runInvestigatorWorker,
} from '../src/core/provenance-investigator-worker.mjs';

const execFileAsync = promisify(execFile);
const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'provenance-investigator-worker.mjs');

const CLAIM = {
  claimId: 'claim-w',
  claimText: 'Compound X reduces Y by 40 percent.',
  authors: ['A. Researcher'],
  institutions: ['Example Institute'],
  provenanceRecord: null,
};

function fixture(responses) {
  const dir = mkdtempSync(join(tmpdir(), 'helmion-investigator-worker-'));
  const claimPath = join(dir, 'claim.json');
  const evidencePath = join(dir, 'evidence.json');
  const outputPath = join(dir, 'dossier.json');
  writeFileSync(claimPath, JSON.stringify(CLAIM));
  writeFileSync(evidencePath, JSON.stringify({ responses }));
  return { dir, claimPath, evidencePath, outputPath };
}

/** Recorded answers for every planned sub-query (empty except replication). */
function fullResponses() {
  const responses = {};
  for (const q of buildInvestigationPlan(CLAIM)) responses[q.queryId] = [];
  const replication = buildInvestigationPlan(CLAIM).find((q) => q.category === 'replication');
  responses[replication.queryId] = [{
    evidenceId: 'w1', category: 'replication', stance: 'supports',
    summary: 'Independent replication succeeded.', sourcePublisher: 'Other University',
  }];
  return responses;
}

test('the recorded lookup answers by query id and throws for an unrecorded sub-query', async () => {
  const lookup = createRecordedLookup({ q1: [] });
  assert.deepEqual(await lookup({ queryId: 'q1', category: 'affiliation', subject: 'X' }), []);
  await assert.rejects(() => lookup({ queryId: 'q9', category: 'rebuttal', subject: 'c' }), /no recorded answer/);
});

test('the worker writes a complete dossier file from recorded answers', async () => {
  const { dir, claimPath, evidencePath, outputPath } = fixture(fullResponses());
  try {
    const dossier = await runInvestigatorWorker({ claimPath, evidencePath, outputPath });
    assert.equal(dossier.status, 'complete');
    assert.deepEqual(dossier.findings.replication, ['w1']);
    const onDisk = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(onDisk.dossierId, 'dossier-claim-w');
    assert.equal(onDisk.contestationVector.consensusRatio, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrecorded sub-query is a NAMED GAP in the written dossier', async () => {
  const responses = fullResponses();
  const lobbying = buildInvestigationPlan(CLAIM).find((q) => q.category === 'lobbying');
  delete responses[lobbying.queryId];
  const { dir, claimPath, evidencePath, outputPath } = fixture(responses);
  try {
    const dossier = await runInvestigatorWorker({ claimPath, evidencePath, outputPath });
    assert.equal(dossier.status, 'partial');
    assert.ok(dossier.gaps.some((g) => g.queryId === lobbying.queryId && /no recorded answer/.test(g.reason)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the worker runs as a real child process: plan mode, then dossier mode', async () => {
  const { dir, claimPath, evidencePath, outputPath } = fixture(fullResponses());
  try {
    const planRun = await execFileAsync(process.execPath, [WORKER, '--claim', claimPath, '--plan']);
    const plan = JSON.parse(planRun.stdout);
    assert.equal(plan.length, 10);
    assert.equal(plan[0].queryId, 'q1');

    const run = await execFileAsync(process.execPath, [
      WORKER, '--claim', claimPath, '--evidence', evidencePath, '--out', outputPath,
    ]);
    assert.match(run.stdout, /dossier dossier-claim-w: status=complete/);
    const onDisk = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(onDisk.status, 'complete');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the worker fails plainly (exit 1, named error) on a missing claim file', async () => {
  const { dir, evidencePath, outputPath } = fixture(fullResponses());
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        WORKER, '--claim', join(dir, 'nope.json'), '--evidence', evidencePath, '--out', outputPath,
      ]),
      (err) => err.code === 1 && /provenance-investigator-worker:/.test(err.stderr),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
