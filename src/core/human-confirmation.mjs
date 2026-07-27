import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import { canonicalJson } from './maestro.mjs';

export const HUMAN_CONFIRMATION_AUDIENCE = 'helmion-maestro-handoff-action-v1';
export const HUMAN_CONFIRMATION_ALGORITHM = 'Ed25519';
export const MAX_CONFIRMATION_TTL_SECONDS = 900;
const CLOCK_SKEW_SECONDS = 60;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const STABLE_ID_PATTERN = /^[a-z0-9][a-z0-9._:@/-]{0,199}$/;
const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{80,120}$/;

export class HumanConfirmationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HumanConfirmationError';
    this.details = details;
  }
}

export class HumanConfirmationRequiredError extends HumanConfirmationError {
  constructor(message = 'A matching unexpired one-time human confirmation is required', details) {
    super(message, details);
    this.name = 'HumanConfirmationRequiredError';
  }
}

function requiredText(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function stableId(value, field) {
  const normalized = requiredText(value, field).toLowerCase();
  if (!STABLE_ID_PATTERN.test(normalized)) {
    throw new TypeError(`${field} must be a stable lowercase identifier`);
  }
  return normalized;
}

function handoffId(value) {
  const normalized = requiredText(value, 'handoffId');
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new TypeError('handoffId must be a positive integer');
  }
  return normalized;
}

function isoTimestamp(value, field) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${field} must be an ISO timestamp`);
  return date.toISOString();
}

function jsonAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('operation must be a JSON object');
  }
  const serialized = canonicalJson(value);
  if (serialized === undefined) throw new TypeError('operation must be JSON serializable');
  return JSON.parse(serialized);
}

export function handoffActionHash({ projectSlug, handoffId: handoffIdInput, operation }) {
  const envelope = {
    version: 1,
    audience: HUMAN_CONFIRMATION_AUDIENCE,
    project_slug: requiredText(projectSlug, 'projectSlug'),
    handoff_id: handoffId(handoffIdInput),
    operation: jsonAction(operation),
  };
  return createHash('sha256').update(canonicalJson(envelope)).digest('hex');
}

export function normalizeHumanConfirmationClaims(input = {}) {
  const actionHash = requiredText(input.action_hash ?? input.actionHash, 'action_hash').toLowerCase();
  if (!HASH_PATTERN.test(actionHash)) {
    throw new TypeError('action_hash must be a lowercase SHA-256 hex digest');
  }
  const nonce = requiredText(input.nonce, 'nonce');
  if (!NONCE_PATTERN.test(nonce)) {
    throw new TypeError('nonce must be a stable 8-200 character identifier');
  }
  const audience = requiredText(input.audience, 'audience');
  if (audience !== HUMAN_CONFIRMATION_AUDIENCE) {
    throw new HumanConfirmationError('Human confirmation audience does not match Helmion');
  }

  return {
    version: Number(input.version),
    audience,
    provider: stableId(input.provider, 'provider'),
    subject: stableId(input.subject, 'subject'),
    key_id: stableId(input.key_id ?? input.keyId, 'key_id'),
    project_slug: requiredText(input.project_slug ?? input.projectSlug, 'project_slug'),
    handoff_id: handoffId(input.handoff_id ?? input.handoffId),
    action_hash: actionHash,
    issued_at: isoTimestamp(input.issued_at ?? input.issuedAt, 'issued_at'),
    expires_at: isoTimestamp(input.expires_at ?? input.expiresAt, 'expires_at'),
    nonce,
  };
}

export function humanConfirmationSigningPayload(claimsInput) {
  const claims = normalizeHumanConfirmationClaims(claimsInput);
  if (claims.version !== 1) {
    throw new HumanConfirmationError('Unsupported human confirmation assertion version');
  }
  return canonicalJson(claims);
}

export function createHumanConfirmationAssertion({ claims, privateKey }) {
  const normalizedClaims = normalizeHumanConfirmationClaims(claims);
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('Human confirmation private key must use Ed25519');
  }
  const signature = sign(
    null,
    Buffer.from(humanConfirmationSigningPayload(normalizedClaims), 'utf8'),
    key,
  ).toString('base64url');
  return { claims: normalizedClaims, signature };
}

export function verifyHumanConfirmationAssertion({
  assertion,
  trustedIdentity,
  expected,
  now = new Date(),
  maxTtlSeconds = MAX_CONFIRMATION_TTL_SECONDS,
}) {
  const claims = normalizeHumanConfirmationClaims(assertion?.claims);
  const signature = requiredText(assertion?.signature, 'signature');
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new HumanConfirmationError('Human confirmation signature is not valid base64url');
  }
  const identity = {
    id: trustedIdentity?.id,
    provider: stableId(trustedIdentity?.provider, 'trusted identity provider'),
    subject: stableId(trustedIdentity?.subject, 'trusted identity subject'),
    key_id: stableId(
      trustedIdentity?.key_id ?? trustedIdentity?.keyId,
      'trusted identity key_id',
    ),
    algorithm: requiredText(trustedIdentity?.algorithm, 'trusted identity algorithm'),
    public_key_pem: requiredText(
      trustedIdentity?.public_key_pem ?? trustedIdentity?.publicKey,
      'trusted identity public key',
    ),
  };
  if (identity.algorithm !== HUMAN_CONFIRMATION_ALGORITHM) {
    throw new HumanConfirmationError('Trusted identity key must use Ed25519');
  }
  if (
    claims.provider !== identity.provider
    || claims.subject !== identity.subject
    || claims.key_id !== identity.key_id
  ) {
    throw new HumanConfirmationError('Signed identity claims do not match the trusted identity key');
  }

  const expectedHash = requiredText(expected?.actionHash, 'expected actionHash').toLowerCase();
  if (
    claims.project_slug !== requiredText(expected?.projectSlug, 'expected projectSlug')
    || claims.handoff_id !== handoffId(expected?.handoffId)
    || claims.action_hash !== expectedHash
  ) {
    throw new HumanConfirmationError(
      'Signed confirmation is not bound to this project, handoff, and action',
    );
  }

  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid timestamp');
  const issuedMs = new Date(claims.issued_at).getTime();
  const expiresMs = new Date(claims.expires_at).getTime();
  const ttlMs = expiresMs - issuedMs;
  if (issuedMs > nowMs + CLOCK_SKEW_SECONDS * 1000) {
    throw new HumanConfirmationError('Human confirmation was issued too far in the future');
  }
  if (expiresMs <= nowMs) throw new HumanConfirmationError('Human confirmation has expired');
  if (ttlMs <= 0 || ttlMs > Number(maxTtlSeconds) * 1000) {
    throw new HumanConfirmationError(
      `Human confirmation lifetime must be at most ${maxTtlSeconds} seconds`,
    );
  }

  const publicKey = createPublicKey(identity.public_key_pem);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new HumanConfirmationError('Trusted identity public key must use Ed25519');
  }
  const valid = verify(
    null,
    Buffer.from(humanConfirmationSigningPayload(claims), 'utf8'),
    publicKey,
    Buffer.from(signature, 'base64url'),
  );
  if (!valid) throw new HumanConfirmationError('Human confirmation signature verification failed');

  const assertionHash = createHash('sha256')
    .update(humanConfirmationSigningPayload(claims))
    .update('\n')
    .update(signature)
    .digest('hex');
  return {
    claims,
    signature,
    assertionHash,
    identity: {
      id: identity.id,
      provider: identity.provider,
      subject: identity.subject,
      key_id: identity.key_id,
      algorithm: identity.algorithm,
    },
  };
}
