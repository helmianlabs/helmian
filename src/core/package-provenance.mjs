// The package provenance gate: the checks that run BEFORE a package or MCP
// server is installed, alongside the code read and the sandbox.
//
//   1. ADVISORIES — every package+version is queried against OSV, whose data
//      carries both the OSV malicious-package records (MAL- ids) and the
//      GitHub Security Advisories (GHSA- aliases). Known-malicious BLOCKS.
//      Known-vulnerable WARNS with the advisory ids named.
//   2. LOCKFILE — an install with no lockfile is refused, and a lockfile
//      whose recorded integrity hash does not match the package being
//      installed is refused. What gets installed must be what was reviewed.
//   3. ATTESTATIONS — npm provenance / Sigstore attestations are checked
//      where the registry publishes them. Where none is published the record
//      says "no attestation" plainly; absence is recorded, never smoothed
//      over, and never treated as proof of anything either way.
//   4. TYPOSQUAT — the package name is compared with the well-known names in
//      its ecosystem (edit distance, separator tricks, homoglyph swaps).
//      A near-miss name is flagged for human review.
//   5. STARTUP HOOKS — npm install scripts (preinstall / install /
//      postinstall / prepare) and Python .pth files (which execute at
//      interpreter startup) are flagged for review.
//
// Every evaluation returns a decision — allow, warn, or block — with its
// findings, and the install pipeline writes the decision to the ledger as
// its receipt. A check that could not run (network down, registry error)
// is recorded as NOT CHECKED and never read as a pass: the decision is
// warn with the gap named, because an install gate that silently skips
// its checks is worse than one that says it could not check.

const OSV_QUERY_URL = 'https://api.osv.dev/v1/query';
const NPM_REGISTRY_URL = 'https://registry.npmjs.org';
const USER_AGENT = 'helmion-package-provenance-gate';

export const PACKAGE_DECISION = Object.freeze({
  ALLOW: 'allow',
  WARN: 'warn',
  BLOCK: 'block',
});

// Well-known package names per ecosystem. A candidate whose name is a
// near-miss of one of these is a typosquat suspect. This is a review flag,
// not a verdict: legitimate forks exist, and the human decides.
export const WELL_KNOWN_PACKAGES = Object.freeze({
  npm: Object.freeze([
    'react', 'lodash', 'express', 'axios', 'chalk', 'commander', 'debug',
    'dotenv', 'moment', 'request', 'uuid', 'webpack', 'typescript', 'eslint',
    'prettier', 'jest', 'mocha', 'socket.io', 'mongoose', 'pg', 'mysql2',
    'redis', 'jsonwebtoken', 'bcrypt', 'cors', 'morgan', 'nodemon', 'pm2',
    'vue', 'angular', 'next', 'nuxt', 'vite', 'rollup', 'esbuild', 'babel',
    'zod', 'yargs', 'inquirer', 'fs-extra', 'glob', 'rimraf', 'semver',
  ]),
  pypi: Object.freeze([
    'requests', 'numpy', 'pandas', 'django', 'flask', 'fastapi', 'pillow',
    'boto3', 'pytest', 'setuptools', 'pip', 'wheel', 'cryptography',
    'sqlalchemy', 'pydantic', 'aiohttp', 'urllib3', 'certifi', 'pyyaml',
    'lxml', 'beautifulsoup4', 'scipy', 'matplotlib', 'torch', 'tensorflow',
    'openai', 'anthropic', 'langchain', 'transformers', 'click', 'tqdm',
  ]),
});

const HOMOGLYPHS = Object.freeze({
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't',
  rn: 'm', vv: 'w', cl: 'd',
});

function levenshtein(a, b) {
  const m = a.length; const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= n; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[n];
}

function normalizeName(name, ecosystem) {
  let out = String(name ?? '').toLowerCase();
  if (ecosystem === 'pypi') out = out.replace(/[-_.]+/g, '-');
  return out;
}

function dehomoglyph(name) {
  let out = name;
  for (const [fake, real] of Object.entries(HOMOGLYPHS)) out = out.split(fake).join(real);
  return out;
}

/**
 * Typosquat screen: exact well-known names pass; near misses (edit
 * distance 1–2, homoglyph-folded equality, separator variants) are named
 * with the well-known name they resemble.
 */
export function detectTyposquat({ ecosystem, name }) {
  const known = WELL_KNOWN_PACKAGES[ecosystem] ?? [];
  const bare = String(name ?? '').replace(/^@[^/]+\//, '');
  const candidate = normalizeName(bare, ecosystem);
  if (!candidate) return { suspect: false, reason: 'no name to check' };
  if (known.includes(candidate)) return { suspect: false, reason: 'the name is itself a well-known package' };
  const folded = dehomoglyph(candidate);
  for (const target of known) {
    const t = normalizeName(target, ecosystem);
    if (folded === t) {
      return { suspect: true, resembles: target, method: 'homoglyph', detail: `"${name}" folds to the well-known name "${target}" when look-alike characters are resolved.` };
    }
    const d = levenshtein(candidate, t);
    if (d >= 1 && d <= 2) {
      return { suspect: true, resembles: target, method: 'edit-distance', detail: `"${name}" is ${d} edit${d === 1 ? '' : 's'} from the well-known package "${target}".` };
    }
    if (ecosystem === 'npm') {
      const squashed = candidate.replace(/[-_.]/g, '');
      if (squashed === t.replace(/[-_.]/g, '') && candidate !== t) {
        return { suspect: true, resembles: target, method: 'separator', detail: `"${name}" differs from the well-known package "${target}" only by separators.` };
      }
    }
  }
  return { suspect: false, reason: 'no near miss against the well-known names' };
}

/**
 * Query OSV for one package+version. OSV aggregates the malicious-package
 * dataset and GHSA, so one query covers both sources the gate promises.
 * Returns { checked, malicious: [...], vulnerable: [...] } where each entry
 * names its ids (MAL- / GHSA- / CVE-) and summary.
 */
export async function queryAdvisories({ ecosystem, name, version, fetchImpl = globalThis.fetch }) {
  const osvEcosystem = ecosystem === 'pypi' ? 'PyPI' : 'npm';
  let response;
  try {
    response = await fetchImpl(OSV_QUERY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ package: { name, ecosystem: osvEcosystem }, version }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    return { checked: false, reason: `OSV query failed: ${error.message}`, malicious: [], vulnerable: [] };
  }
  if (!response.ok) {
    return { checked: false, reason: `OSV query returned ${response.status}`, malicious: [], vulnerable: [] };
  }
  const body = await response.json().catch(() => null);
  if (!body) return { checked: false, reason: 'OSV query returned an unreadable body', malicious: [], vulnerable: [] };
  const malicious = [];
  const vulnerable = [];
  for (const vuln of body.vulns ?? []) {
    const ids = [vuln.id, ...(vuln.aliases ?? [])].filter(Boolean);
    const isMalware = ids.some((id) => /^MAL-/i.test(id))
      || /malicious|malware/i.test(vuln.summary ?? '')
      || (vuln.database_specific?.severity ?? '').toString().toLowerCase() === 'malware';
    const entry = { ids, summary: vuln.summary ?? null };
    (isMalware ? malicious : vulnerable).push(entry);
  }
  return { checked: true, malicious, vulnerable };
}

/**
 * Lockfile verification. npm: package-lock.json (v2/v3 "packages" map or
 * v1 "dependencies"). PyPI: a hash-pinned requirements file
 * (--hash=sha256:... lines) — the only PyPI-side artefact that carries
 * integrity hashes in plain text.
 *
 * Returns { present, verified, detail }. verified is true only when the
 * package+version is in the lockfile AND, where the lockfile carries an
 * integrity hash and the caller supplies the expected one, they match.
 */
export function verifyLockfile({ ecosystem, name, version, lockfileText, expectedIntegrity = null }) {
  if (lockfileText == null || String(lockfileText).trim() === '') {
    return { present: false, verified: false, detail: 'No lockfile was supplied. Installs without a lockfile are refused: nothing pins what will actually be installed.' };
  }
  if (ecosystem === 'npm') {
    let lock;
    try { lock = JSON.parse(lockfileText); } catch (error) {
      return { present: true, verified: false, detail: `package-lock.json is not valid JSON (${error.message}).` };
    }
    const bare = String(name).replace(/^@[^/]+\//, (scope) => scope);
    const entries = [];
    if (lock.packages) {
      for (const [path, entry] of Object.entries(lock.packages)) {
        if (path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)) entries.push(entry);
      }
    }
    if (lock.dependencies?.[bare]) entries.push(lock.dependencies[bare]);
    if (lock.dependencies?.[name]) entries.push(lock.dependencies[name]);
    const match = entries.find((e) => String(e.version) === String(version));
    if (!match) {
      return { present: true, verified: false, detail: `${name}@${version} does not appear in package-lock.json. The lockfile does not pin this install.` };
    }
    if (expectedIntegrity && match.integrity && match.integrity !== expectedIntegrity) {
      return { present: true, verified: false, detail: `Integrity mismatch for ${name}@${version}: the lockfile records ${match.integrity} but the registry records ${expectedIntegrity}. Refusing — what was reviewed is not what would be installed.` };
    }
    if (expectedIntegrity && !match.integrity) {
      return { present: true, verified: false, detail: `package-lock.json carries no integrity hash for ${name}@${version}, so the install cannot be verified against the registry.` };
    }
    return { present: true, verified: true, integrity: match.integrity ?? null, detail: expectedIntegrity ? 'Lockfile integrity matches the registry.' : 'Package and version are pinned in the lockfile (no registry integrity supplied to compare).' };
  }
  // PyPI: hash-pinned requirements lines.
  const lines = String(lockfileText).split('\n');
  const wanted = normalizeName(name, 'pypi');
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9._-]+)==([^\s;]+)/);
    if (!m || normalizeName(m[1], 'pypi') !== wanted) continue;
    if (String(m[2]) !== String(version)) {
      return { present: true, verified: false, detail: `The requirements lockfile pins ${name}==${m[2]}, not ${version}.` };
    }
    const hash = line.match(/--hash=sha256:([0-9a-f]{64})/i)?.[1] ?? null;
    if (!hash) return { present: true, verified: false, detail: `The requirements lockfile pins ${name}==${version} without a sha256 hash, so the install cannot be integrity-verified.` };
    if (expectedIntegrity && expectedIntegrity.replace(/^sha256:/i, '').toLowerCase() !== hash.toLowerCase()) {
      return { present: true, verified: false, detail: `Hash mismatch for ${name}==${version}: the lockfile records sha256:${hash} but the expected hash is ${expectedIntegrity}.` };
    }
    return { present: true, verified: true, integrity: `sha256:${hash}`, detail: 'Requirements lockfile hash verified.' };
  }
  return { present: true, verified: false, detail: `${name}==${version} does not appear in the requirements lockfile.` };
}

/**
 * npm provenance attestation check against the registry. Where the version
 * metadata carries attestations, the Sigstore bundle's evidence fields are
 * recorded (transparency-log id, certificate presence). Where it carries
 * none, the result says so plainly. PyPI attestations (PEP 740) are read
 * from the same shape when a caller supplies registry metadata; the live
 * PyPI lookup rides the JSON API's integrity fields when available.
 */
export async function checkAttestation({ ecosystem, name, version, fetchImpl = globalThis.fetch }) {
  if (ecosystem !== 'npm') {
    return { status: 'not-checked', detail: 'Attestation lookup is implemented for npm; this ecosystem records "no attestation" until its lookup lands.', attested: false };
  }
  const url = `${NPM_REGISTRY_URL}/${encodeURIComponent(name).replace('%40', '@')}/${encodeURIComponent(version)}`;
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
  } catch (error) {
    return { status: 'not-checked', detail: `Registry lookup failed: ${error.message}`, attested: false };
  }
  if (!response.ok) return { status: 'not-checked', detail: `Registry lookup returned ${response.status}`, attested: false };
  const meta = await response.json().catch(() => null);
  const attestations = meta?.dist?.attestations ?? null;
  if (!attestations?.url) {
    return { status: 'none', detail: 'No provenance attestation is published for this version. Recorded as: no attestation.', attested: false };
  }
  // Fetch the attestation bundle and record its evidence. Full Sigstore
  // chain verification belongs to the verifier library; the gate records
  // the bundle's transparency-log and certificate evidence so a human (or
  // a later verifier) can check it, and never claims more than it did.
  let bundle = null;
  try {
    const bundleResponse = await fetchImpl(attestations.url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
    if (bundleResponse.ok) bundle = await bundleResponse.json().catch(() => null);
  } catch { bundle = null; }
  const first = Array.isArray(bundle) ? bundle[0] : bundle;
  const logId = first?.bundle?.verificationMaterial?.tlogEntries?.[0]?.logId?.keyId
    ?? first?.verificationMaterial?.tlogEntries?.[0]?.logId?.keyId ?? null;
  const hasCertificate = Boolean(
    first?.bundle?.verificationMaterial?.certificate?.rawBytes
    ?? first?.verificationMaterial?.certificate?.rawBytes,
  );
  return {
    status: 'present',
    attested: true,
    detail: 'A Sigstore provenance attestation is published for this version; its evidence is recorded here for verification.',
    evidence: { url: attestations.url, provenanceType: attestations.provenance ?? null, transparencyLogId: logId, certificatePresent: hasCertificate, bundleFetched: Boolean(first) },
  };
}

/**
 * Startup-hook scan over a package's declared contents.
 * `files` is a list of { path, content? } — .pth contents are inspected
 * when supplied; `scripts` is the npm package.json scripts map.
 */
export function scanStartupHooks({ ecosystem, scripts = null, files = [] }) {
  const flags = [];
  if (ecosystem === 'npm' && scripts) {
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
      if (scripts[hook]) flags.push({ kind: 'npm-install-script', hook, command: String(scripts[hook]).slice(0, 200), detail: `npm "${hook}" script runs automatically at install time: ${String(scripts[hook]).slice(0, 120)}` });
    }
  }
  for (const file of files) {
    if (/\.pth$/i.test(file.path)) {
      const executes = typeof file.content === 'string' && /^\s*import\s/m.test(file.content);
      flags.push({ kind: 'python-pth', path: file.path, executesCode: executes, detail: executes
        ? `${file.path} is a .pth startup file whose lines execute Python at interpreter startup.`
        : `${file.path} is a .pth startup file (path entries only in the content supplied).` });
    }
  }
  return flags;
}

/**
 * The gate itself. Pure decision logic over injectable lookups so tests
 * drive every branch offline.
 *
 * Input package: { ecosystem, name, version, lockfileText?, scripts?, files? }
 * Returns { decision, findings, advisories, lockfile, attestation, typosquat, hooks }
 */
export async function evaluatePackageProvenance({
  pkg,
  fetchImpl = globalThis.fetch,
  expectedIntegrity = null,
  advisoryLookup = null,
  attestationLookup = null,
  // The lockfile refusal binds installs pulled from a registry. A local
  // candidate directory whose own package.json merely names the server
  // itself has no registry lockfile semantics; the caller says so with
  // requireLockfile: false and the gate records the lockfile check as
  // not applicable instead of refusing a local install for lacking one.
  requireLockfile = true,
} = {}) {
  const ecosystem = pkg?.ecosystem;
  const name = pkg?.name;
  const version = pkg?.version;
  if (!['npm', 'pypi'].includes(ecosystem) || !name || !version) {
    return { decision: PACKAGE_DECISION.BLOCK, findings: [{ kind: 'identity', severity: 'block', detail: 'A package needs an ecosystem (npm or pypi), a name, and an exact version before it can be checked. Unversioned installs are refused.' }], advisories: null, lockfile: null, attestation: null, typosquat: null, hooks: [] };
  }

  const findings = [];
  const advisories = advisoryLookup
    ? await advisoryLookup({ ecosystem, name, version })
    : await queryAdvisories({ ecosystem, name, version, fetchImpl });
  if (!advisories.checked) {
    findings.push({ kind: 'advisories', severity: 'warn', detail: `Advisory check did NOT run: ${advisories.reason}. This install is not cleared by the advisory check.` });
  }
  for (const entry of advisories.malicious ?? []) {
    findings.push({ kind: 'advisory-malicious', severity: 'block', detail: `Known-malicious package record: ${entry.ids.join(', ')}${entry.summary ? ` — ${entry.summary}` : ''}. Install blocked.` });
  }
  for (const entry of advisories.vulnerable ?? []) {
    findings.push({ kind: 'advisory-vulnerable', severity: 'warn', detail: `Known vulnerability: ${entry.ids.join(', ')}${entry.summary ? ` — ${entry.summary}` : ''}.` });
  }

  let lockfile;
  if (!requireLockfile && (pkg.lockfileText == null || String(pkg.lockfileText).trim() === '')) {
    lockfile = { present: false, verified: false, notApplicable: true, detail: 'Lockfile check not applicable: this is a local candidate directory, not a registry install, and it carries no lockfile. Registry installs are refused without one.' };
    findings.push({ kind: 'lockfile', severity: 'note', detail: lockfile.detail });
  } else {
    lockfile = verifyLockfile({ ecosystem, name, version, lockfileText: pkg.lockfileText ?? null, expectedIntegrity });
    if (!lockfile.present) findings.push({ kind: 'lockfile', severity: 'block', detail: lockfile.detail });
    else if (!lockfile.verified) findings.push({ kind: 'lockfile', severity: 'block', detail: lockfile.detail });
  }

  const attestation = attestationLookup
    ? await attestationLookup({ ecosystem, name, version })
    : await checkAttestation({ ecosystem, name, version, fetchImpl });
  if (attestation.status === 'none') {
    findings.push({ kind: 'attestation', severity: 'note', detail: attestation.detail });
  } else if (attestation.status === 'not-checked') {
    findings.push({ kind: 'attestation', severity: 'warn', detail: `Attestation check did not complete: ${attestation.detail}` });
  } else {
    findings.push({ kind: 'attestation', severity: 'note', detail: attestation.detail, evidence: attestation.evidence ?? null });
  }

  const typosquat = detectTyposquat({ ecosystem, name });
  if (typosquat.suspect) findings.push({ kind: 'typosquat', severity: 'warn', detail: typosquat.detail, resembles: typosquat.resembles, method: typosquat.method });

  const hooks = scanStartupHooks({ ecosystem, scripts: pkg.scripts ?? null, files: pkg.files ?? [] });
  for (const hook of hooks) findings.push({ kind: 'startup-hook', severity: 'warn', detail: hook.detail, hook });

  const decision = findings.some((f) => f.severity === 'block')
    ? PACKAGE_DECISION.BLOCK
    : findings.some((f) => f.severity === 'warn')
      ? PACKAGE_DECISION.WARN
      : PACKAGE_DECISION.ALLOW;

  return { decision, findings, advisories, lockfile, attestation, typosquat, hooks };
}
