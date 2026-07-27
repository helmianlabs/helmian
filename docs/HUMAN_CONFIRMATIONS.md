# Identity-backed one-time human confirmations

## Security properties

The local Phase Two confirmation slice adds a cryptographic authorization
primitive without adding an unauthenticated approval endpoint.

- **Verifiable identity:** an Ed25519 public key is durably mapped to
  `(provider, subject, key_id)` in `helmion.human_identity_keys`.
- **Exact action binding:** the signed SHA-256 hash covers protocol audience,
  project slug, handoff ID, and canonical operation JSON.
- **Short lifetime:** assertions expire and may live for at most 15 minutes.
- **Replay resistance:** a signed nonce is unique for its trusted identity
  key.
- **One-time use:** the active target lease atomically marks one matching
  confirmation consumed. A retry with the same idempotency key replays the
  original durable result; another key cannot consume it again.
- **Revocation:** recording and consumption both reject inactive, expired, or
  revoked trusted identity keys.

Approval-like text, model votes, and legacy `confirmed_by`/`confirmed_at`
fields do not satisfy this protocol.

## Migration

`sql/003_human_confirmations.sql` creates:

- `human_identity_keys`;
- `human_handoff_confirmations`; and
- the `CONSUME_CONFIRMATION` idempotent Maestro operation type.

Do not edit migrations `001` or `002`, because their applied checksums are
durable. Apply `003` through the same endpoint-guarded checksummed runner only
after reviewing it for the intended database.

## Trust enrollment boundary

Helmion deliberately has no MCP or coordinator method for enrolling a trusted
identity key. Otherwise an agent could create its own trust root and approve
its own action.

The product owner must choose an authenticated enrollment authority before
live rollout, such as an existing owner/admin web session, enterprise identity
provider, or locally administered hardware-backed key ceremony. That control
path should:

1. verify the human identity;
2. accept only an Ed25519 public key;
3. assign stable `provider`, `subject`, and unique `key_id` values;
4. record validity and revocation state; and
5. keep the private key outside Helmion and Neon.

Direct SQL enrollment is suitable only for isolated development and must be
performed by a trusted database owner using parameters, never string-built
SQL. No enrollment is performed by this repository automatically.

## Assertion format

The signer signs the canonical JSON returned by
`humanConfirmationSigningPayload` from
`src/core/human-confirmation.mjs`. Claims are:

```json
{
  "version": 1,
  "audience": "helmion-maestro-handoff-action-v1",
  "provider": "owner-idp",
  "subject": "user:stable-id",
  "key_id": "owner-key-2026-01",
  "project_slug": "project-a",
  "handoff_id": "42",
  "action_hash": "<64 lowercase hex characters>",
  "issued_at": "2026-07-27T04:10:00.000Z",
  "expires_at": "2026-07-27T04:15:00.000Z",
  "nonce": "unique-confirmation-identifier"
}
```

The signature is base64url Ed25519. `createHumanConfirmationAssertion` exists
as a library/test helper; production signing should happen in the chosen
human-facing identity surface.

To calculate the exact action hash offline, send JSON to the CLI:

```powershell
@'
{
  "projectSlug": "project-a",
  "handoffId": "42",
  "operation": {
    "migration": true,
    "migrationName": "003_human_confirmations.sql"
  }
}
'@ | node .\bin\helmion.mjs confirmation-action-hash
```

Any change to the project, handoff, or operation changes the hash and
invalidates the assertion.

## Adapter and MCP sequence

Read-write coordinator mode adds:

1. `recordHumanConfirmation` /
   `helmion_maestro_record_human_confirmation`
   - recomputes the exact action hash;
   - locks the project and handoff;
   - loads an already-trusted identity key;
   - verifies identity, signature, audience, timestamps, nonce, and binding;
   - durably stores the confirmation.
2. `authorizeHandoffOperation` /
   `helmion_maestro_authorize_handoff_action`
   - requires the active lease created as the handoff target;
   - recomputes the exact action hash;
   - atomically consumes one unexpired, unused matching confirmation;
   - persists the idempotent authorization result.

The pure `evaluateHandoffOperation` gate never trusts caller-supplied approval
text or a database flag. It continues to allow Tier A scoped work with an
incomplete-handoff warning, preserving Phase One behavior, but every Tier B
handoff action is blocked until the consuming authorization call succeeds.

## Deliberate limits

- Advisor consensus remains read-only evidence and never becomes a human
  confirmation.
- Confirmations do not enable flag-to-block rule promotion.
- Confirmations do not create a production-data writer.
- This repository does not execute the downstream Tier B operation. A failed
  operation after confirmation consumption requires a new human confirmation,
  which is the fail-closed behavior.
- Identity enrollment and private-key custody remain product-level decisions.
