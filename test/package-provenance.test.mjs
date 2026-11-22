// The package provenance gate: advisories (OSV + GHSA), lockfile integrity,
// provenance attestations, the typosquat screen, and startup hooks — plus
// the pipeline wiring that halts an install on a block and writes the
// receipt. The named fixtures (AgreeTo, js-logger-pack, agent-framework
// 1.26.1 / 1.26.2) are real-world malicious-package cases; their advisory
// records are modelled here so the suite runs offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluatePackageProvenance,
  queryAdvisories,
  verifyLockfile,
  detectTyposquat,
  scanStartupHooks,
  PACKAGE_DECISION,
} from '../src/core/package-provenance.mjs';
import { runInstallPipeline } from '../src/core/mcp-install-pipeline.mjs';
import { readLedger } from '../src/core/mcp-install-ledger.mjs';

const CLEAN = async () => ({ checked: true, malicious: [], vulnerable: [] });
const NO_ATTESTATION = async () => ({ status: 'none', detail: 'No provenance attestation is published for this version. Recorded as: no attestation.', attested: false });
const MALICIOUS = (ids) => async () => ({ checked: true, malicious: [{ ids, summary: 'This package was identified as malicious.' }], vulnerable: [] });

function npmLock(name, version, integrity = 'sha512-AAA=') {
  return JSON.stringify({
    name, version, lockfileVersion: 3,
    packages: { '': { name, version }, [`node_modules/${name}`]: { version, integrity } },
  });
}

// ── The named fixtures ──────────────────────────────────────────────────────

test('fixture: AgreeTo (PyPI) is blocked on its malicious advisory record', async () => {
  const result = await evaluatePackageProvenance({
    pkg: { ecosystem: 'pypi', name: 'AgreeTo', version: '0.1.0', lockfileText: 'agreeto==0.1.0 --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    advisoryLookup: MALICIOUS(['MAL-2024-0001', 'GHSA-0000-agreeto']),
    attestationLookup: NO_ATTESTATION,
  });
  assert.equal(result.decision, PACKAGE_DECISION.BLOCK);
  assert.ok(result.findings.some((f) => f.kind === 'advisory-malicious'));
});

test('fixture: js-logger-pack (npm) is blocked on its malicious advisory record', async () => {
  const result = await evaluatePackageProvenance({
    pkg: { ecosystem: 'npm', name: 'js-logger-pack', version: '1.0.0', lockfileText: npmLock('js-logger-pack', '1.0.0') },
    advisoryLookup: MALICIOUS(['MAL-2024-0002']),
    attestationLookup: NO_ATTESTATION,
  });
  assert.equal(result.decision, PACKAGE_DECISION.BLOCK);
  assert.ok(result.findings.some((f) => f.kind === 'advisory-malicious'));
});

test('fixtures: agent-framework 1.26.1 and 1.26.2 are blocked; a clean later version is not blocked by advisories', async () => {
  const advisoryFor = (badVersions) => async ({ version }) => (badVersions.includes(version)
    ? { checked: true, malicious: [{ ids: ['MAL-2025-0003', 'GHSA-0000-agent-framework'], summary: 'Compromised release.' }], vulnerable: [] }
    : { checked: true, malicious: [], vulnerable: [] });
  for (const version of ['1.26.1', '1.26.2']) {
    const result = await evaluatePackageProvenance({
      pkg: { ecosystem: 'npm', name: 'agent-framework', version, lockfileText: npmLock('agent-framework', version) },
      advisoryLookup: advisoryFor(['1.26.1', '1.26.2']),
      attestationLookup: NO_ATTESTATION,
    });
    assert.equal(result.decision, PACKAGE_DECISION.BLOCK, `agent-framework ${version} must be blocked`);
  }
  const clean = await evaluatePackageProvenance({
    pkg: { ecosystem: 'npm', name: 'agent-framework', version: '1.26.3', lockfileText: npmLock('agent-framework', '1.26.3') },
    advisoryLookup: advisoryFor(['1.26.1', '1.26.2']),
    attestationLookup: NO_ATTESTATION,
  });
  assert.notEqual(clean.decision, PACKAGE_DECISION.BLOCK);
});

// ── OSV parsing: MAL ids are malicious; GHSA-only vulnerability records warn ─

test('OSV parsing splits malicious records from ordinary vulnerabilities', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({
      vulns: [
        { id: 'MAL-2025-1111', summary: 'Malicious package', aliases: ['GHSA-aaaa-bbbb-cccc'] },
        { id: 'GHSA-dddd-eeee-ffff', summary: 'Prototype pollution', aliases: ['CVE-2025-0001'] },
      ],
    }),
  });
  const result = await queryAdvisories({ ecosystem: 'npm', name: 'whatever', version: '1.0.0', fetchImpl });
  assert.equal(result.checked, true);
  assert.equal(result.malicious.length, 1);
  assert.equal(result.vulnerable.length, 1);
  assert.ok(result.vulnerable[0].ids.includes('GHSA-dddd-eeee-ffff'));
});

test('an advisory check that cannot run warns — it never reads as a pass', async () => {
  const result = await evaluatePackageProvenance({
    pkg: { ecosystem: 'npm', name: 'some-lib', version: '2.0.0', lockfileText: npmLock('some-lib', '2.0.0') },
    advisoryLookup: async () => ({ checked: false, reason: 'OSV query failed: network down', malicious: [], vulnerable: [] }),
    attestationLookup: NO_ATTESTATION,
  });
  assert.equal(result.decision, PACKAGE_DECISION.WARN);
  assert.ok(result.findings.some((f) => f.kind === 'advisories' && /did NOT run/.test(f.detail)));
});

// ── Lockfile ────────────────────────────────────────────────────────────────

test('an install with no lockfile is refused', async () => {
  const result = await evaluatePackageProvenance({
    pkg: { ecosystem: 'npm', name: 'some-lib', version: '2.0.0' },
    advisoryLookup: CLEAN,
    attestationLookup: NO_ATTESTATION,
  });
  assert.equal(result.decision, PACKAGE_DECISION.BLOCK);
  assert.ok(result.findings.some((f) => f.kind === 'lockfile' && /No lockfile/.test(f.detail)));
});

test('lockfile integrity mismatch refuses the install; a match verifies', () => {
  const bad = verifyLockfile({ ecosystem: 'npm', name: 'some-lib', version: '2.0.0', lockfileText: npmLock('some-lib', '2.0.0', 'sha512-AAA='), expectedIntegrity: 'sha512-BBB=' });
  assert.equal(bad.verified, false);
  assert.match(bad.detail, /Integrity mismatch/);
  const good = verifyLockfile({ ecosystem: 'npm', name: 'some-lib', version: '2.0.0', lockfileText: npmLock('some-lib', '2.0.0', 'sha512-AAA='), expectedIntegrity: 'sha512-AAA=' });
  assert.equal(good.verified, true);
  const absent = verifyLockfile({ ecosystem: 'npm', name: 'some-lib', version: '9.9.9', lockfileText: npmLock('some-lib', '2.0.0') });
  assert.equal(absent.verified, false);
});

test('PyPI hash-pinned requirements verify; unpinned or wrong-version entries refuse', () => {
  const hash = 'b'.repeat(64);
  const good = verifyLockfile({ ecosystem: 'pypi', name: 'requests', version: '2.32.0', lockfileText: `requests==2.32.0 --hash=sha256:${hash}` });
  assert.equal(good.verified, true);
  const noHash = verifyLockfile({ ecosystem: 'pypi', name: 'requests', version: '2.32.0', lockfileText: 'requests==2.32.0' });
  assert.equal(noHash.verified, false);
});

// ── Attestation: absence is recorded plainly and does not block ─────────────

test('"no attestation" is recorded plainly and does not by itself block a clean package', async () => {
  const result = await evaluatePackageProvenance({
    pkg: { ecosystem: 'npm', name: 'some-lib', version: '2.0.0', lockfileText: npmLock('some-lib', '2.0.0') },
    advisoryLookup: CLEAN,
    attestationLookup: NO_ATTESTATION,
  });
  assert.equal(result.decision, PACKAGE_DECISION.ALLOW);
  assert.ok(result.findings.some((f) => f.kind === 'attestation' && /no attestation/i.test(f.detail)));
});

// ── Typosquat ───────────────────────────────────────────────────────────────

test('typosquat screen flags near misses of well-known names and passes the names themselves', () => {
  assert.equal(detectTyposquat({ ecosystem: 'npm', name: 'react' }).suspect, false);
  assert.equal(detectTyposquat({ ecosystem: 'npm', name: 'lodahs' }).suspect, true);
  assert.equal(detectTyposquat({ ecosystem: 'npm', name: '1odash' }).suspect, true);
  assert.equal(detectTyposquat({ ecosystem: 'pypi', name: 'reqeusts' }).suspect, true);
  assert.equal(detectTyposquat({ ecosystem: 'pypi', name: 'requests' }).suspect, false);
  assert.equal(detectTyposquat({ ecosystem: 'npm', name: 'totally-unrelated-lib' }).suspect, false);
});

// ── Startup hooks ───────────────────────────────────────────────────────────

test('npm install scripts and Python .pth files are flagged for review', () => {
  const flags = scanStartupHooks({
    ecosystem: 'npm',
    scripts: { postinstall: 'node setup.js', test: 'node --test' },
    files: [{ path: 'site-packages/evil.pth', content: 'import os; os.system("x")' }, { path: 'README.md', content: 'hi' }],
  });
  assert.ok(flags.some((f) => f.kind === 'npm-install-script' && f.hook === 'postinstall'));
  assert.ok(flags.some((f) => f.kind === 'python-pth' && f.executesCode === true));
  assert.ok(!flags.some((f) => /test/.test(f.hook ?? '')));
});

// ── Pipeline wiring: a blocked package halts the install and writes receipts ─

test('pipeline: a malicious package candidate is blocked before approval, with ledger receipts', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmion-prov-test-'));
  try {
    const candidate = join(scratch, 'candidate');
    await mkdir(candidate, { recursive: true });
    await writeFile(join(candidate, 'package.json'), JSON.stringify({ name: 'js-logger-pack', version: '1.0.0', scripts: {} }));
    await writeFile(join(candidate, 'package-lock.json'), npmLock('js-logger-pack', '1.0.0'));
    await writeFile(join(candidate, 'index.mjs'), 'export const x = 1;\n');
    await writeFile(join(candidate, 'helmion-candidate.json'), JSON.stringify({ name: 'js-logger-pack', purpose: 'test fixture' }));
    const ledgerDir = join(scratch, 'ledger');
    let approveCalled = false;
    const report = await runInstallPipeline({
      root: candidate,
      ledgerDir,
      installRoot: join(scratch, 'installed'),
      approve: async () => { approveCalled = true; return { approved: true }; },
      runSandbox: false,
      connectionString: null,
      packageGateOptions: { advisoryLookup: MALICIOUS(['MAL-2024-0002']), attestationLookup: NO_ATTESTATION },
    });
    assert.equal(report.finalDecision, 'blocked-by-package-provenance');
    assert.equal(approveCalled, false, 'a human was asked to approve a package the gate blocked');
    assert.equal(report.stages.packageProvenance.decision, 'block');
    const ledgerText = await readFile(join(ledgerDir, 'ledger.jsonl'), 'utf8').catch(() => '');
    const entries = ledgerText.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(entries.some((e) => e.decision === 'package-provenance'), 'the gate decision receipt is in the ledger');
    assert.ok(entries.some((e) => e.decision === 'blocked'), 'the block receipt is in the ledger');
    const viaReader = await readLedger({ ledgerDir });
    assert.ok(Array.isArray(viaReader) && viaReader.some((e) => e.decision === 'package-provenance'));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
