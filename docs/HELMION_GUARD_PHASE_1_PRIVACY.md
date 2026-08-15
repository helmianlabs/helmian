# Helmion Guard — Phase 1/2 privacy and permissions

This is the Phase 1/2 boundary for Helmion Guard. It is a local browser guard,
not an LLM proxy. No Edge/Chrome store submission or external data mutation is
part of this phase.

## Minimal permissions matrix

| Capability | Manifest permission | Why it is needed | Not requested |
| --- | --- | --- | --- |
| Persist the bounded local finding ledger | `storage` | The service worker can be evicted; `chrome.storage.local` preserves the user-visible ledger across restarts. | `unlimitedStorage`, `downloads`, `tabs`, `scripting`, cookies, identity |
| Read supported AI chat pages | `content_scripts.matches` for `claude.ai`, `chatgpt.com`, `gemini.google.com`, `grok.com` | Runs the local DOM extractor only on the four supported hosts. | `<all_urls>`, host permissions, arbitrary origins |
| Run the scanner | No additional permission | The MV3 service worker performs deterministic local regex checks. | Network, native messaging, remote code |

The manifest must continue to contain exactly one permission (`storage`) and no
`host_permissions` or `optional_permissions`. Changing that matrix requires a
separate review because it expands user trust and data scope.

## Local-first redaction boundary

`extension/background/redact.js` is the mandatory first step for any future
optional verifier/provider prompt. It removes common email, phone, SSN, payment
card, IP, bearer-token, API-key, secret-assignment, and private-key values before
a prompt can be constructed. Its telemetry contains only `redactedCount` and a
sorted list of `redactedTypes`; it never logs the original value or redacted
text. The current extension has no outbound LLM path and remains network-free.

The redaction function is not a claim of perfect detection. It is a fail-closed
privacy boundary: a future outbound path must call it and must be covered by a
test that proves the raw fixture value is absent from both prompt text and
telemetry. A provider or remote verifier may not be added by simply importing a
client into the content script.

## Zero-data-retention behavior

- Page text is read in memory for the deterministic scan and is not sent over a
  network connection.
- The durable local ledger stores only bounded findings required to explain a
  flag. It uses `chrome.storage.local`; the extension has no server-side ledger
  or analytics endpoint.
- Redaction telemetry is counts/types only. Raw PII and secrets are not logged.
- No model prompt, provider request, remote cache, or account profile is created
  in Phase 1/2. Any later provider phase needs a new, explicit retention and
  consent decision before implementation.
- Clearing the Guard ledger removes the extension's local evidence. Browser
  history, the AI site's own retention, and OS backups are outside this
  extension's control.

