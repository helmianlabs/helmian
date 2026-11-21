// The Sandbox Investigator as a runnable worker (Milestone 2 of Scribe
// 1154). The investigator core (provenance-investigator.mjs) holds no
// capabilities; this entry point is what a caller actually runs:
//
//   node src/core/provenance-investigator-worker.mjs \
//     --claim claim.json --evidence evidence.json --out dossier.json
//
//   claim.json     { claimId, claimText, authors, institutions,
//                    provenanceRecord } — the claim plus its Milestone 1
//                    Stage 1 provenance record.
//   evidence.json  { responses: { "<queryId>": [evidenceItem, ...] } } —
//                    the answers to the deterministic plan's sub-queries,
//                    gathered OUTSIDE this process by whatever harness the
//                    caller trusts (an agent with search tools, a registry
//                    export, a human researcher). Query ids come from
//                    buildInvestigationPlan for the same claim.
//   dossier.json   the Conflict & Provenance Dossier, written here.
//
// Because the lookups arrive as a file, this process performs NO network
// access of its own and writes only the dossier. A sub-query with no
// recorded answer is a named gap in the dossier, never a silent "nothing
// found". The worker reports by writing its file — the detached-worker
// contract — so it can be spawned detached and found again by its output.

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { buildInvestigationPlan, runInvestigation } from './provenance-investigator.mjs';

/** A lookup backed by recorded answers, keyed by the plan's query ids. */
export function createRecordedLookup(responses = {}) {
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) {
    throw new TypeError('recorded evidence must be an object keyed by queryId');
  }
  return async (subquery) => {
    if (!Object.hasOwn(responses, subquery.queryId)) {
      throw new Error(`no recorded answer for sub-query ${subquery.queryId} (${subquery.category}: ${subquery.subject})`);
    }
    return responses[subquery.queryId];
  };
}

export async function runInvestigatorWorker({ claimPath, evidencePath, outputPath, limits } = {}) {
  for (const [name, value] of [['claimPath', claimPath], ['evidencePath', evidencePath], ['outputPath', outputPath]]) {
    if (typeof value !== 'string' || value === '') throw new TypeError(`runInvestigatorWorker needs a ${name}`);
  }
  const claim = JSON.parse(await readFile(claimPath, 'utf8'));
  const evidenceFile = JSON.parse(await readFile(evidencePath, 'utf8'));
  const lookup = createRecordedLookup(evidenceFile.responses ?? {});
  const dossier = await runInvestigation({ claim, lookup, limits });
  await writeFile(outputPath, `${JSON.stringify(dossier, null, 2)}\n`, 'utf8');
  return dossier;
}

/** The plan a caller needs before gathering evidence for a claim file. */
export async function planForClaimFile(claimPath) {
  const claim = JSON.parse(await readFile(claimPath, 'utf8'));
  return buildInvestigationPlan(claim);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--') || argv[i + 1] === undefined) {
      throw new Error('usage: provenance-investigator-worker.mjs --claim <file> --evidence <file> --out <file> | --claim <file> --plan');
    }
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('--plan')) {
      const claimPath = argv[argv.indexOf('--claim') + 1];
      if (!claimPath) throw new Error('usage: provenance-investigator-worker.mjs --claim <file> --plan');
      const plan = await planForClaimFile(claimPath);
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      const args = parseArgs(argv);
      const dossier = await runInvestigatorWorker({
        claimPath: args.claim, evidencePath: args.evidence, outputPath: args.out,
      });
      process.stdout.write(`dossier ${dossier.dossierId}: status=${dossier.status} evidence=${dossier.evidence.length} gaps=${dossier.gaps.length} rejected=${dossier.rejected.length}\n`);
    }
  } catch (err) {
    process.stderr.write(`provenance-investigator-worker: ${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
