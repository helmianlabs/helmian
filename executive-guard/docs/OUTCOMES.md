# POST /v1/audit/outcomes

A device reports what happened after Executive Guard gave it a decision. The report is appended to the hash-chained audit trail as a `decision.outcome` entry, linked to the `decision.issued` entry by `decisionId`.

## Request

```
POST /v1/audit/outcomes
Authorization: Bearer <device token>        (the same token used for POST /v1/decisions)
Content-Type: application/json              (max 32 KB)

{
  "decisionId": "4f0c1e8a-6c1b-4d55-9b7e-2a1f3c9d0e11",
  "nonce":      "the nonce the device sent with POST /v1/decisions",
  "status":     "succeeded" | "failed" | "refused",
  "startedAt":  "2026-10-22T10:00:00.000Z",
  "finishedAt": "2026-10-22T10:00:01.500Z",
  "resultHash": "<64 lowercase hex, SHA-256 of the result>",
  "error":      "short reason, at most 500 characters"
}
```

| Field | Required | Rule |
|---|---|---|
| `decisionId` | yes | The UUID from the signed decision's payload. |
| `nonce` | yes | 16–128 url-safe characters; must be the nonce the decision was issued for. For a decision that came from an approval, it is the nonce of the original `POST /v1/decisions`. |
| `status` | yes | `succeeded`: the action ran and worked. `failed`: it ran and failed. `refused`: the device did not run it (deny verdict, failed verification, expired, user cancelled). |
| `startedAt` | yes, except for `refused` | ISO 8601 UTC with `Z`, at most 5 minutes ahead of the server clock. |
| `finishedAt` | yes | Same format; not before `startedAt`. |
| `resultHash` | no | SHA-256 hex of whatever the device considers the result. Never send the result itself. |
| `error` | no | Only with `failed` or `refused`. Control characters are replaced with spaces. Do not put secrets or output in it. |

Any other field is rejected (`unknown-field`).

The server verifies the decision's verdict against the reported status. A `deny` decision can only be reported as `refused`. An `allow` decision can be reported with any status. An `ask` response (HTTP 202) is not a decision to act on and cannot be reported. Report the decision that the approval poll returns instead.

Each decision can be reported once. Reports are accepted until 24 hours after the decision's `exp`.

## Responses

`201 Created`
```json
{ "recorded": true, "decisionId": "4f0c1e8a-…", "status": "succeeded", "auditSeq": 42, "auditHash": "<sha256 hex of the audit entry>" }
```

Errors are `{ "error": "<code>", "message": "<text>" }`:

| HTTP | `error` | When |
|---|---|---|
| 400 | `invalid-json` | Body is not JSON. |
| 400 | `invalid-body` | Body is not a JSON object. |
| 400 | `unknown-field` | A field outside the table above. |
| 400 | `invalid-decision-id` | `decisionId` is not a UUID. |
| 400 | `invalid-nonce` | `nonce` is malformed. |
| 400 | `invalid-status` | `status` is not one of the three values. |
| 400 | `invalid-time` | `startedAt`/`finishedAt` missing, malformed, in the future, or out of order. |
| 400 | `invalid-result-hash` | `resultHash` is not 64 lowercase hex. |
| 400 | `invalid-error` | `error` on `succeeded`, not a string, or over 500 characters. |
| 401 | `unauthorized` | No bearer, an unknown token, or an approver token. |
| 403 | `nonce-mismatch` | The decision exists for this device but the nonce is wrong. |
| 404 | `unknown-decision` | No such decision, a decision issued to another device, or an `ask`. These cases share one answer, so a device cannot probe for other devices' decisions. |
| 405 | `method-not-allowed` | Any method other than POST. |
| 409 | `duplicate-outcome` | An outcome is already recorded for this decision. Duplicates are detected across restarts too, because the index is rebuilt from the audit file. |
| 409 | `verdict-mismatch` | A `deny` decision reported as `succeeded` or `failed`. |
| 410 | `outcome-window-closed` | More than 24 hours after the decision's `exp`. |
| 413 | `body-too-large` | Body is over 32 KB. |
| 415 | `unsupported-media-type` | Content-Type is not `application/json`. |

A refused report is not recorded, so the device can fix it and send it again.

## Audit entry

```json
{ "seq": 42, "at": "…", "prevHash": "…", "event": "decision.outcome",
  "decisionId": "…", "deviceId": "hands-mcp", "approvalId": "… (only if it came from an approval)",
  "verdict": "allow", "actionHash": "…", "status": "succeeded",
  "startedAt": "…", "durationMs": 1500, "finishedAt": "…",
  "resultHash": "…", "error": "…", "hash": "…" }
```

The nonce is never written to the audit trail. `decision.issued` entries now carry `nonceHash` (SHA-256 of the nonce) and `exp`, which let the server check an outcome after a restart. Decisions issued before this change have no `nonceHash`, so they cannot be reported (`unknown-decision`).
