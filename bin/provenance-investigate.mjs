#!/usr/bin/env node
// Live provenance investigation (Scribe 1154, Milestone 2 + live harness):
//   node bin/provenance-investigate.mjs --claim claim.json [--out dossier.json]
// The claim file: { claimId, claimText, authors?, institutions?,
// provenanceRecord? }. The investigation runs against the live public
// registries (Europe PMC + Crossref) through src/agent/provenance-live-lookup.mjs,
// and prints the dossier summary: status, the contestation vector, the
// guardrail verdict the dossier produces, and every gap by name.

import { readFileSync, writeFileSync } from 'node:fs';

import { runInvestigation, toGuardrailClaim } from '../src/core/provenance-investigator.mjs';
import { evaluateClaimGuardrails } from '../src/core/provenance-verification.mjs';
import { createLiveLookup } from '../src/agent/provenance-live-lookup.mjs';

const args = process.argv.slice(2);
const claimPath = args[args.indexOf('--claim') + 1];
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
if (!claimPath || claimPath.startsWith('--')) {
  console.error('usage: provenance-investigate.mjs --claim <claim.json> [--out <dossier.json>]');
  process.exit(2);
}

const claim = JSON.parse(readFileSync(claimPath, 'utf8'));
const lookup = createLiveLookup({ claim });
const dossier = await runInvestigation({ claim, lookup });
const guardrail = evaluateClaimGuardrails(toGuardrailClaim(dossier));

const summary = {
  dossierId: dossier.dossierId,
  status: dossier.status,
  evidence: dossier.evidence.map((e) => ({ id: e.evidenceId, category: e.category, stance: e.stance, independent: e.independent })),
  rejected: dossier.rejected.length,
  gaps: dossier.gaps,
  vector: dossier.contestationVector,
  guardrail: { action: guardrail.action, reasons: guardrail.reasons },
};
console.log(JSON.stringify(summary, null, 2));
if (outPath) writeFileSync(outPath, `${JSON.stringify(dossier, null, 2)}\n`);
