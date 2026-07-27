import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  dirname,
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  HUMAN_CONFIRMATION_AUDIENCE,
  createHumanConfirmationAssertion,
  handoffActionHash,
} from '../core/human-confirmation.mjs';
import { canonicalJson } from '../core/maestro.mjs';
import { PILOT_DECISION, evaluatePilotAction } from '../core/pilot-policy.mjs';

const LOCAL_KEY_VERSION = 1;
const RECOVERY_VERSION = 1;
const ENROLLMENT_VERSION = 1;
const PASSPHRASE_ENVELOPE_VERSION = 1;
const LOCAL_UNLOCK_PURPOSE = 'helmion-owner-key-local-unlock';
const RECOVERY_PURPOSE = 'helmion-owner-key-recovery';
const DEFAULT_SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const APPROVAL_TTL_SECONDS = 300;
const PRIVATE_FILE_SUFFIX = '.owner-key.dpapi.json';
const RECOVERY_FILE_SUFFIX = '.owner-key.recovery.json';
const ENROLLMENT_FILE_SUFFIX = '.owner-key.public.json';

function requiredText(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function stableId(value, field) {
  const normalized = requiredText(value, field).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:@/-]{0,199}$/.test(normalized)) {
    throw new TypeError(`${field} must be a stable lowercase identifier`);
  }
  return normalized;
}

function asSecretBuffer(value, field = 'recovery passphrase') {
  const buffer = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value ?? ''), 'utf8');
  if (buffer.length < 16 || buffer.length > 1024) {
    buffer.fill(0);
    throw new TypeError(`${field} must be between 16 and 1024 bytes`);
  }
  return buffer;
}

function assertDistinctPassphrases(firstInput, secondInput) {
  let first;
  let second;
  try {
    first = asSecretBuffer(firstInput, 'approval passphrase');
    second = asSecretBuffer(secondInput, 'recovery passphrase');
    if (first.length === second.length && timingSafeEqual(first, second)) {
      throw new Error('Approval and recovery passphrases must be different');
    }
  } finally {
    first?.fill(0);
    second?.fill(0);
  }
}

export function assertConfirmedPassphrase(first, second, label = 'Passphrase') {
  const normalizedLabel = requiredText(label, 'passphrase label');
  if (!Buffer.isBuffer(first) || !Buffer.isBuffer(second)) {
    throw new TypeError('Passphrase confirmation requires byte buffers');
  }
  if (first.length !== second.length || !timingSafeEqual(first, second)) {
    throw new Error(`${normalizedLabel} passphrases did not match`);
  }
  if (first.length < 16) {
    throw new Error(`${normalizedLabel} passphrase must be at least 16 characters`);
  }
  return true;
}

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShellBytes(script, input, operation) {
  if (process.platform !== 'win32') {
    throw new Error(`${operation} requires Windows DPAPI`);
  }
  const inputBuffer = Buffer.from(input);
  let result;
  try {
    result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
      {
        input: inputBuffer,
        encoding: null,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } finally {
    inputBuffer.fill(0);
  }
  if (result.error) throw new Error(`${operation} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const diagnostic = Buffer.from(result.stderr ?? [])
      .toString('utf8')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(-4000);
    throw new Error(
      `${operation} failed with exit code ${result.status}`
      + (diagnostic ? `: ${diagnostic}` : ''),
    );
  }
  return Buffer.from(result.stdout);
}

const DPAPI_PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$memory = New-Object System.IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($memory)
$plain = $memory.ToArray()
try {
  $protected = [System.Security.Cryptography.ProtectedData]::Protect(
    $plain,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [Console]::OpenStandardOutput().Write($protected, 0, $protected.Length)
} finally {
  if ($plain) { [Array]::Clear($plain, 0, $plain.Length) }
}
`;

const DPAPI_UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$memory = New-Object System.IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($memory)
$protected = $memory.ToArray()
$plain = $null
try {
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protected,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [Console]::OpenStandardOutput().Write($plain, 0, $plain.Length)
} finally {
  if ($plain) { [Array]::Clear($plain, 0, $plain.Length) }
}
`;

const RESTRICT_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$memory = New-Object System.IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($memory)
$path = [Text.Encoding]::UTF8.GetString($memory.ToArray())
$item = Get-Item -LiteralPath $path
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
if ($item.PSIsContainer) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  $acl = New-Object Security.AccessControl.FileSecurity
  $inheritance = [Security.AccessControl.InheritanceFlags]::None
}
$acl.SetOwner($current)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($current, $system)) {
  $rule = New-Object Security.AccessControl.FileSystemAccessRule(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
}
$item.SetAccessControl($acl)
$verified = $item.GetAccessControl()
if (-not $verified.AreAccessRulesProtected) {
  throw 'Owner-key ACL still inherits permissions'
}
$allowed = @($current.Value, $system.Value)
$rules = $verified.GetAccessRules(
  $true,
  $false,
  [Security.Principal.SecurityIdentifier]
)
foreach ($existingRule in $rules) {
  if ($allowed -notcontains $existingRule.IdentityReference.Value) {
    throw "Unexpected owner-key ACL identity: $($existingRule.IdentityReference.Value)"
  }
}
`;

export function dpapiProtectCurrentUser(plainBytes) {
  return runPowerShellBytes(
    DPAPI_PROTECT_SCRIPT,
    Buffer.from(plainBytes),
    'Windows CurrentUser DPAPI protection',
  );
}

export function dpapiUnprotectCurrentUser(protectedBytes) {
  return runPowerShellBytes(
    DPAPI_UNPROTECT_SCRIPT,
    Buffer.from(protectedBytes),
    'Windows CurrentUser DPAPI unprotection',
  );
}

function restrictToCurrentWindowsUser(path) {
  runPowerShellBytes(
    RESTRICT_ACL_SCRIPT,
    Buffer.from(resolve(path), 'utf8'),
    'Windows owner-key ACL restriction',
  );
}

export function defaultOwnerKeyDirectory() {
  const localAppData = process.env.LOCALAPPDATA
    ? resolve(process.env.LOCALAPPDATA)
    : join(homedir(), 'AppData', 'Local');
  return join(localAppData, 'Helmion', 'owner-keys');
}

function isWithin(parent, target) {
  const relation = relative(resolve(parent), resolve(target));
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

export function assertSensitivePathOutsideWorkspace(path, workspaceRoot = process.cwd()) {
  if (isWithin(workspaceRoot, path)) {
    throw new Error(
      `Sensitive owner-key material must be outside the workspace: ${resolve(workspaceRoot)}`,
    );
  }
  return resolve(path);
}

function assertDedicatedDirectory(path, expectedName) {
  const resolved = resolve(path);
  const leaf = basename(resolved).toLowerCase();
  if (leaf !== expectedName) {
    throw new Error(`Sensitive directory must use the dedicated name "${expectedName}"`);
  }
  return resolved;
}

async function assertMissing(path) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`Refusing to overwrite existing file: ${path}`);
}

async function writeJsonExclusive(path, value, { secure = false } = {}) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  if (secure) restrictToCurrentWindowsUser(dirname(target));
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  try {
    if (secure) restrictToCurrentWindowsUser(target);
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
  return target;
}

function fingerprint(publicKeyDer) {
  return createHash('sha256').update(publicKeyDer).digest('hex');
}

function ownerKeyId(createdAt, publicFingerprint) {
  const day = createdAt.toISOString().slice(0, 10).replaceAll('-', '');
  return `owner-${day}-${publicFingerprint.slice(0, 12)}`;
}

function enrollmentMaterial(metadata, publicKeyPem) {
  return {
    version: ENROLLMENT_VERSION,
    purpose: 'helmion-owner-human-confirmation',
    provider: metadata.provider,
    subject: metadata.subject,
    key_id: metadata.key_id,
    algorithm: 'Ed25519',
    public_key_pem: publicKeyPem,
    fingerprint_sha256: metadata.fingerprint_sha256,
    created_at: metadata.created_at,
  };
}

function passphraseAad(metadata, purpose) {
  return {
    version: PASSPHRASE_ENVELOPE_VERSION,
    purpose,
    provider: metadata.provider,
    subject: metadata.subject,
    key_id: metadata.key_id,
    algorithm: 'Ed25519',
    fingerprint_sha256: metadata.fingerprint_sha256,
    created_at: metadata.created_at,
  };
}

function encryptPassphraseEnvelope(
  privateKeyDer,
  passphraseInput,
  metadata,
  { purpose, scryptN = DEFAULT_SCRYPT_N },
) {
  const passphrase = asSecretBuffer(passphraseInput);
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  let key;
  try {
    key = scryptSync(passphrase, salt, 32, {
      N: scryptN,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
    const aad = Buffer.from(canonicalJson(passphraseAad(metadata, purpose)), 'utf8');
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(privateKeyDer), cipher.final()]);
    return {
      ...passphraseAad(metadata, purpose),
      protection: 'scrypt-aes-256-gcm',
      kdf: {
        name: 'scrypt',
        N: scryptN,
        r: SCRYPT_R,
        p: SCRYPT_P,
        salt_base64: salt.toString('base64'),
      },
      cipher: {
        name: 'aes-256-gcm',
        nonce_base64: nonce.toString('base64'),
        tag_base64: cipher.getAuthTag().toString('base64'),
        ciphertext_base64: ciphertext.toString('base64'),
      },
    };
  } finally {
    passphrase.fill(0);
    key?.fill(0);
  }
}

function decryptPassphraseEnvelope(envelope, passphraseInput, expectedPurpose) {
  if (
    envelope?.version !== PASSPHRASE_ENVELOPE_VERSION
    || envelope?.purpose !== expectedPurpose
    || envelope?.protection !== 'scrypt-aes-256-gcm'
    || envelope?.kdf?.name !== 'scrypt'
    || envelope?.cipher?.name !== 'aes-256-gcm'
  ) {
    throw new Error(`Unsupported Helmion passphrase envelope for ${expectedPurpose}`);
  }
  const passphrase = asSecretBuffer(passphraseInput);
  let key;
  try {
    const n = Number(envelope.kdf.N);
    const r = Number(envelope.kdf.r);
    const p = Number(envelope.kdf.p);
    if (
      !Number.isInteger(n)
      || n < 4096
      || n > 1_048_576
      || (n & (n - 1)) !== 0
      || r !== SCRYPT_R
      || p !== SCRYPT_P
    ) {
      throw new Error('Recovery package has unsafe scrypt parameters');
    }
    const salt = Buffer.from(envelope.kdf.salt_base64, 'base64');
    const nonce = Buffer.from(envelope.cipher.nonce_base64, 'base64');
    const tag = Buffer.from(envelope.cipher.tag_base64, 'base64');
    const ciphertext = Buffer.from(envelope.cipher.ciphertext_base64, 'base64');
    if (salt.length !== 32 || nonce.length !== 12 || tag.length !== 16 || !ciphertext.length) {
      throw new Error('Recovery package has invalid cryptographic field lengths');
    }
    key = scryptSync(passphrase, salt, 32, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(
      Buffer.from(canonicalJson(passphraseAad(envelope, expectedPurpose)), 'utf8'),
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } finally {
    passphrase.fill(0);
    key?.fill(0);
  }
}

export function encryptRecoveryPackage(
  privateKeyDer,
  passphraseInput,
  metadata,
  { scryptN = DEFAULT_SCRYPT_N } = {},
) {
  return encryptPassphraseEnvelope(privateKeyDer, passphraseInput, metadata, {
    purpose: RECOVERY_PURPOSE,
    scryptN,
  });
}

export function decryptRecoveryPackage(recovery, passphraseInput) {
  if (recovery?.version !== RECOVERY_VERSION) {
    throw new Error('Unsupported Helmion owner-key recovery package');
  }
  return decryptPassphraseEnvelope(recovery, passphraseInput, RECOVERY_PURPOSE);
}

function encryptLocalUnlockPackage(
  privateKeyDer,
  passphraseInput,
  metadata,
  { scryptN = DEFAULT_SCRYPT_N } = {},
) {
  return encryptPassphraseEnvelope(privateKeyDer, passphraseInput, metadata, {
    purpose: LOCAL_UNLOCK_PURPOSE,
    scryptN,
  });
}

function decryptLocalUnlockPackage(envelope, passphraseInput) {
  return decryptPassphraseEnvelope(envelope, passphraseInput, LOCAL_UNLOCK_PURPOSE);
}

function localKeyRecord(metadata, publicEnrollment, protectedPrivateKey) {
  return {
    version: LOCAL_KEY_VERSION,
    purpose: 'helmion-owner-human-confirmation',
    protection: 'windows-dpapi-current-user+approval-passphrase-aes-256-gcm',
    provider: metadata.provider,
    subject: metadata.subject,
    key_id: metadata.key_id,
    fingerprint_sha256: metadata.fingerprint_sha256,
    created_at: metadata.created_at,
    public_enrollment: publicEnrollment,
    protected_private_key_base64: protectedPrivateKey.toString('base64'),
  };
}

async function readJson(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`${label} could not be read: ${error.message}`);
  }
  return parsed;
}

function validateLocalKeyRecord(record) {
  if (
    record?.version !== LOCAL_KEY_VERSION
    || record?.protection
      !== 'windows-dpapi-current-user+approval-passphrase-aes-256-gcm'
    || record?.public_enrollment?.algorithm !== 'Ed25519'
  ) {
    throw new Error('Unsupported Helmion local owner-key record');
  }
  validatePublicEnrollment(record.public_enrollment, record);
  if (!/^[A-Za-z0-9+/=]+$/.test(record.protected_private_key_base64 ?? '')) {
    throw new Error('Owner-key record does not contain valid DPAPI ciphertext');
  }
  return record;
}

function validatePublicEnrollment(enrollment, metadata) {
  if (
    enrollment?.version !== ENROLLMENT_VERSION
    || enrollment?.algorithm !== 'Ed25519'
    || enrollment?.provider !== metadata.provider
    || enrollment?.subject !== metadata.subject
    || enrollment?.key_id !== metadata.key_id
    || enrollment?.fingerprint_sha256 !== metadata.fingerprint_sha256
  ) {
    throw new Error('Public enrollment metadata does not match the owner key');
  }
  const publicKey = createPublicKey(enrollment.public_key_pem);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Owner public enrollment key must use Ed25519');
  }
  const enrolledFingerprint = fingerprint(
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  if (enrolledFingerprint !== metadata.fingerprint_sha256) {
    throw new Error('Owner public enrollment fingerprint does not match its key');
  }
  return enrollment;
}

export async function initializeOwnerKey({
  provider,
  subject,
  keyDirectory = defaultOwnerKeyDirectory(),
  publicOutput,
  recoveryOutput,
  approvalPassphrase,
  recoveryPassphrase,
  workspaceRoot = process.cwd(),
  now = new Date(),
  scryptN = DEFAULT_SCRYPT_N,
} = {}) {
  const normalizedProvider = stableId(provider, 'provider');
  const normalizedSubject = stableId(subject, 'subject');
  const keyDir = assertDedicatedDirectory(
    assertSensitivePathOutsideWorkspace(keyDirectory, workspaceRoot),
    'owner-keys',
  );
  const recoveryPath = assertSensitivePathOutsideWorkspace(
    requiredText(recoveryOutput, 'recoveryOutput'),
    workspaceRoot,
  );
  const publicPath = resolve(requiredText(publicOutput, 'publicOutput'));
  const createdAt = new Date(now);
  if (!Number.isFinite(createdAt.getTime())) throw new TypeError('now must be a valid date');

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privateKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const publicFingerprint = fingerprint(publicKeyDer);
  const keyId = ownerKeyId(createdAt, publicFingerprint);
  const metadata = {
    provider: normalizedProvider,
    subject: normalizedSubject,
    key_id: keyId,
    fingerprint_sha256: publicFingerprint,
    created_at: createdAt.toISOString(),
  };
  const localPath = join(keyDir, `${keyId}${PRIVATE_FILE_SUFFIX}`);
  const enrollment = enrollmentMaterial(metadata, publicKeyPem);
  let protectedPrivateKey;
  let localUnlockPackage;
  let recovery;
  const createdFiles = [];
  try {
    await Promise.all([
      assertMissing(localPath),
      assertMissing(publicPath),
      assertMissing(recoveryPath),
    ]);
    assertDistinctPassphrases(approvalPassphrase, recoveryPassphrase);
    localUnlockPackage = encryptLocalUnlockPackage(
      privateKeyDer,
      approvalPassphrase,
      metadata,
      { scryptN },
    );
    const localEnvelopeBytes = Buffer.from(JSON.stringify(localUnlockPackage), 'utf8');
    try {
      protectedPrivateKey = dpapiProtectCurrentUser(localEnvelopeBytes);
    } finally {
      localEnvelopeBytes.fill(0);
    }
    recovery = encryptRecoveryPackage(
      privateKeyDer,
      recoveryPassphrase,
      metadata,
      { scryptN },
    );
    createdFiles.push(await writeJsonExclusive(
      recoveryPath,
      { ...recovery, public_enrollment: enrollment },
      { secure: false },
    ));
    createdFiles.push(await writeJsonExclusive(publicPath, enrollment));
    createdFiles.push(await writeJsonExclusive(
      localPath,
      localKeyRecord(metadata, enrollment, protectedPrivateKey),
      { secure: true },
    ));
  } catch (error) {
    await Promise.all(createdFiles.map((path) => rm(path, { force: true })));
    throw error;
  } finally {
    privateKeyDer.fill(0);
  }

  return {
    created: true,
    key_id: keyId,
    provider: normalizedProvider,
    subject: normalizedSubject,
    fingerprint_sha256: publicFingerprint,
    local_key_path: localPath,
    public_enrollment_path: publicPath,
    recovery_path: recoveryPath,
    private_key_exported: false,
    enrollment_performed: false,
  };
}

export async function inspectOwnerKey({ keyPath }) {
  const record = validateLocalKeyRecord(await readJson(keyPath, 'Owner key'));
  return {
    version: record.version,
    protection: record.protection,
    provider: record.provider,
    subject: record.subject,
    key_id: record.key_id,
    fingerprint_sha256: record.fingerprint_sha256,
    created_at: record.created_at,
    local_key_path: resolve(keyPath),
    private_key_exported: false,
  };
}

export async function exportOwnerPublicEnrollment({ keyPath, output }) {
  const record = validateLocalKeyRecord(await readJson(keyPath, 'Owner key'));
  const outputPath = await writeJsonExclusive(
    requiredText(output, 'output'),
    record.public_enrollment,
  );
  return {
    key_id: record.key_id,
    fingerprint_sha256: record.fingerprint_sha256,
    public_enrollment_path: outputPath,
    private_key_exported: false,
  };
}

export async function restoreOwnerKey({
  recoveryPath,
  keyDirectory = defaultOwnerKeyDirectory(),
  recoveryPassphrase,
  approvalPassphrase,
  workspaceRoot = process.cwd(),
  scryptN = DEFAULT_SCRYPT_N,
} = {}) {
  const keyDir = assertDedicatedDirectory(
    assertSensitivePathOutsideWorkspace(keyDirectory, workspaceRoot),
    'owner-keys',
  );
  const recovery = await readJson(recoveryPath, 'Owner-key recovery package');
  assertDistinctPassphrases(approvalPassphrase, recoveryPassphrase);
  const privateKeyDer = decryptRecoveryPackage(recovery, recoveryPassphrase);
  let protectedPrivateKey;
  try {
    const privateKey = createPrivateKey({
      key: privateKeyDer,
      format: 'der',
      type: 'pkcs8',
    });
    const publicKeyDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const restoredFingerprint = fingerprint(publicKeyDer);
    if (restoredFingerprint !== recovery.fingerprint_sha256) {
      throw new Error('Recovery package private key does not match its public fingerprint');
    }
    validatePublicEnrollment(recovery.public_enrollment, recovery);
    const localUnlockPackage = encryptLocalUnlockPackage(
      privateKeyDer,
      approvalPassphrase,
      recovery,
      { scryptN },
    );
    const localEnvelopeBytes = Buffer.from(JSON.stringify(localUnlockPackage), 'utf8');
    try {
      protectedPrivateKey = dpapiProtectCurrentUser(localEnvelopeBytes);
    } finally {
      localEnvelopeBytes.fill(0);
    }
    const localPath = join(keyDir, `${recovery.key_id}${PRIVATE_FILE_SUFFIX}`);
    await assertMissing(localPath);
    await writeJsonExclusive(
      localPath,
      localKeyRecord(recovery, recovery.public_enrollment, protectedPrivateKey),
      { secure: true },
    );
    return {
      restored: true,
      key_id: recovery.key_id,
      fingerprint_sha256: restoredFingerprint,
      local_key_path: localPath,
      private_key_exported: false,
      enrollment_performed: false,
    };
  } finally {
    privateKeyDer.fill(0);
  }
}

export async function reviewAndSignOwnerConfirmation({
  keyPath,
  requestPath,
  output,
  decisionProvider,
  approvalPassphraseProvider,
  now = new Date(),
  workspaceRoot = process.cwd(),
} = {}) {
  if (typeof decisionProvider !== 'function') {
    throw new TypeError('decisionProvider is required');
  }
  if (typeof approvalPassphraseProvider !== 'function') {
    throw new TypeError('approvalPassphraseProvider is required');
  }
  const record = validateLocalKeyRecord(await readJson(keyPath, 'Owner key'));
  const request = await readJson(requestPath, 'Owner confirmation request');
  const operation = request.operation;
  const policy = evaluatePilotAction(operation, request.guardState ?? {});
  if (policy.decision === PILOT_DECISION.AUTO_RUN) {
    throw new Error('Tier A actions auto-run inside guardrails and must not receive owner signatures');
  }
  if (policy.decision === PILOT_DECISION.BLOCK) {
    throw new Error(`Blocked guardrail cannot be overridden: ${policy.reasons.join('; ')}`);
  }
  const projectSlug = requiredText(request.projectSlug, 'request projectSlug');
  const handoffId = requiredText(request.handoffId, 'request handoffId');
  const actionHash = handoffActionHash({ projectSlug, handoffId, operation });
  const review = {
    decision_required: 'APPROVE or DECLINE',
    project_slug: projectSlug,
    handoff_id: handoffId,
    plain_english_action: requiredText(
      operation?.description,
      'operation.description',
    ),
    risk_tier: policy.tier,
    risk_reasons: policy.reasons,
    exact_action_hash: actionHash,
    operation,
    key_id: record.key_id,
    identity: {
      provider: record.provider,
      subject: record.subject,
    },
  };
  const decision = String(await decisionProvider(review)).trim().toUpperCase();
  if (decision === 'DECLINE') {
    return {
      decision: 'DECLINED',
      signed: false,
      output_written: false,
      action_hash: actionHash,
    };
  }
  if (decision !== 'APPROVE') {
    throw new Error('Owner decision must be exactly APPROVE or DECLINE');
  }

  const issuedAt = new Date(now);
  if (!Number.isFinite(issuedAt.getTime())) throw new TypeError('now must be a valid date');
  const expiresAt = new Date(issuedAt.getTime() + APPROVAL_TTL_SECONDS * 1000);
  const protectedPrivateKey = Buffer.from(record.protected_private_key_base64, 'base64');
  const protectedEnvelope = dpapiUnprotectCurrentUser(protectedPrivateKey);
  let localUnlockPackage;
  try {
    localUnlockPackage = JSON.parse(protectedEnvelope.toString('utf8'));
  } catch {
    throw new Error('DPAPI owner-key payload is not a valid local unlock package');
  } finally {
    protectedEnvelope.fill(0);
  }
  const approvalPassphrase = await approvalPassphraseProvider();
  let privateKeyDer;
  try {
    privateKeyDer = decryptLocalUnlockPackage(
      localUnlockPackage,
      approvalPassphrase,
    );
    const privateKey = createPrivateKey({
      key: privateKeyDer,
      format: 'der',
      type: 'pkcs8',
    });
    const signingFingerprint = fingerprint(
      createPublicKey(privateKey).export({ type: 'spki', format: 'der' }),
    );
    if (signingFingerprint !== record.fingerprint_sha256) {
      throw new Error('DPAPI owner key does not match its public enrollment fingerprint');
    }
    const assertion = createHumanConfirmationAssertion({
      privateKey: {
        key: privateKeyDer,
        format: 'der',
        type: 'pkcs8',
      },
      claims: {
        version: 1,
        audience: HUMAN_CONFIRMATION_AUDIENCE,
        provider: record.provider,
        subject: record.subject,
        key_id: record.key_id,
        project_slug: projectSlug,
        handoff_id: handoffId,
        action_hash: actionHash,
        issued_at: issuedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        nonce: `owner-${randomUUID()}`,
      },
    });
    const outputTarget = assertSensitivePathOutsideWorkspace(
      requiredText(output, 'output'),
      workspaceRoot,
    );
    assertDedicatedDirectory(dirname(outputTarget), 'confirmations');
    const outputPath = await writeJsonExclusive(outputTarget, {
      version: 1,
      decision: 'APPROVED',
      action: {
        project_slug: projectSlug,
        handoff_id: handoffId,
        action_hash: actionHash,
        operation,
      },
      assertion,
    }, { secure: true });
    return {
      decision: 'APPROVED',
      signed: true,
      output_written: true,
      action_hash: actionHash,
      expires_at: expiresAt.toISOString(),
      assertion_path: outputPath,
      private_key_exported: false,
    };
  } finally {
    privateKeyDer?.fill(0);
    if (Buffer.isBuffer(approvalPassphrase)) approvalPassphrase.fill(0);
  }
}

export const OWNER_KEY_FILE_SUFFIXES = Object.freeze({
  local: PRIVATE_FILE_SUFFIX,
  recovery: RECOVERY_FILE_SUFFIX,
  public: ENROLLMENT_FILE_SUFFIX,
});
