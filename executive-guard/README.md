# Executive Guard — verification server

Signed allow / deny / ask decisions, human approvals, and a hash-chained audit
trail, for the Helmian Guard browser extension (and any other client that
can describe an action).

Status: **working locally, tested; not deployed anywhere.** Where it should be
hosted is Troy's decision. `sql/schema.sql` is the Postgres shape for a hosted
version and has **not** been applied to any database.

## Run it locally

```bash
EXEC_GUARD_DEVICE_TOKENS="troy-laptop=<24+ char device token>" \
EXEC_GUARD_APPROVER_TOKENS="troy=<24+ char approver token>" \
npm run executive-guard
```

It listens on `http://127.0.0.1:8787` (loopback only), creates
`.executive-guard/signing-key.pem` (Ed25519, mode 0600) on first run, appends to
`.executive-guard/audit.jsonl`, and prints the key id. Compare that key id with
the one the extension popup shows after pairing.

## API

| Method | Path | Auth | What |
| --- | --- | --- | --- |
| GET | `/healthz` | none | liveness |
| GET | `/v1/keys` | none | `{ keyId, alg: "Ed25519", publicKeyJwk }` |
| POST | `/v1/decisions` | device | `{ action, nonce }` -> `200 {verdict: allow\|deny, decision}` or `202 {verdict: ask, approvalId, decision}` |
| GET | `/v1/approvals/:id` | device (own only) | `{ status: pending\|approved\|denied\|expired, decision? }` |
| GET | `/v1/approvals?status=pending` | approver | list approvals |
| POST | `/v1/approvals/:id/decide` | approver | `{ approve: true\|false, reason? }` |
| GET | `/v1/audit?limit&sinceSeq` | approver | audit entries |
| GET | `/v1/audit/verify` | approver | re-verify the whole chain |

`action` = `{ kind, site, contentHash (sha256 hex), riskSignals[], summary (<=500 chars, redacted), target? }`.
Kinds: `prompt.send`, `prompt.paste`, `code.reveal`, `network.request`, `agent.tool`.
A summary that still carries a key, token, password or card number is refused
(`400 unredacted-content`) and never stored.

A `decision` is `{ payload, signature, keyId }`: `payload` is base64url of the
canonical JSON claims `{ aud, decisionId, verdict, ruleId, actionHash, deviceId,
nonce, iat, exp, approvalId?, decidedBy? }`, signed with Ed25519. Decisions live
5 minutes; approvals expire after 15 minutes; nonces cannot be replayed.

## Hands connector interface (`/guard/v1`, PR #52)

The hands MCP connector designed in helmianlabs/helmian PR #52
(`docs/hands/HANDS_MCP_CONNECTOR_DESIGN.md` §5) is a client of this server. It
authenticates with a **service token** (`EXEC_GUARD_SERVICE_TOKENS`, a separate
table from device and approver tokens). Code: `src/hands.mjs`.

| Endpoint | Who | What |
|---|---|---|
| `GET /guard/v1/keys` | anyone | same Ed25519 key as `/v1/keys`, plus the signing-string description |
| `POST /guard/v1/decide` | service | §5.1 request → `allow` / `deny` / `pending_approval` |
| `GET /guard/v1/approvals/{id}?waitMs=` | service (own only) | §5.2 state; long-poll up to 25 s |
| `POST /guard/v1/audit` | service | §5.3 outcome → `201 {seq, hash}` |

- `argumentsDigest` = `"sha256:"` + lowercase hex SHA-256 of the canonical JSON
  of `arguments` (`src/canonical.mjs`: sorted keys, no whitespace). Guard
  recomputes it and returns `400 arguments-digest-mismatch` if it differs.
- `signature` = `"ed25519:"` + base64url Ed25519 over the UTF-8 bytes of
  `decisionId`, `requestId`, `argumentsDigest`, `decision`, `expiresAt` joined
  with `\n`. The response carries `keyId` and a top-level `expiresAt` (decision
  expiry, 300 s; for `pending_approval` it equals `approval.expiresAt`, 15 min).
  `verifyHands()` in `src/hands.mjs` is the reference verifier.
- `requestId` (8–128 url-safe chars) is the idempotency key: the same id with
  the same digest returns the same response; a different digest is `409`.
  `requestedAt` more than 5 minutes from Guard's clock is `400 stale-request`.
- Approvals are decided by a human through the existing approver endpoints
  (`/v1/approvals`), `channel: "app"`. Once decided, the approval gets exactly
  one decision (`allow`/`deny`, signed, stable `decisionId` on every re-poll).
  Pending and expired approvals carry `signature: null`.
- Audit: `executed`/`failed` on a decision that was not `allow`, or a second
  `executed` for the same `decisionId`, is `409` and is itself written to the
  chain as `hands.violation`.
- Default postures (§4): reads inside configured workspace roots
  (`EXEC_GUARD_HANDS_ROOTS_PC` / `_RUNNER`; none configured means deny), secret
  paths denied (`.env*`, `*.pem|key|pfx|p12`, `id_rsa*`, `%APPDATA%\Helmian`);
  `ollama_generate` allow (PC only); `run_powershell` approval for allow-listed
  ids only (`EXEC_GUARD_HANDS_COMMANDS`), never free text; `open_url` https only,
  allow-listed hosts allowed, others need approval; `write_file` approval inside
  roots. `hands.act` tools need the `hands.act` scope; constraints are
  `{maxRuntimeMs: 30000, maxOutputBytes: 65536, readOnly}`.

## Policy

`src/policy.mjs` `DEFAULT_POLICY`, first match wins, unknown = deny:
secrets -> deny; SSN -> ask; destructive intent -> ask; contact details -> ask;
deny-listed host -> deny; no signals -> allow. Override with
`EXEC_GUARD_POLICY=/path/policy.json`. The extension carries the same policy
offline (`extension/background/local-policy.js`), pinned by a parity test.

## Security notes

- Tokens are compared as SHA-256 digests with `timingSafeEqual`; tokens under
  24 characters are ignored.
- No CORS headers: a web page cannot read a decision. The extension's
  background worker reaches the server through an optional host permission the
  user grants from the popup.
- Approvals and nonces are held in memory (lost on restart, so pending approvals
  must be re-requested). The audit trail is durable (JSONL, hash-chained, checked
  on load).

## Tests

`npm run test:executive-guard` (policy, audit chain, HTTP server). The
extension-side loop is tested against this real server in
`extension/test/executive-loop.test.mjs` and
`extension/test/active-guard-end-to-end.test.mjs`.
