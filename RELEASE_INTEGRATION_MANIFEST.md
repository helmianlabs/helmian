# Helmian Cloud release integration manifest

**Canonical source:** `E:\helmian-workspace-release-2026-08-12`  
**Branch:** `release/maestro-workspace-2026-08-12`  
**Remote:** `https://github.com/helmianlabs/helmian.git`  
**Observed local origin ref:** `c728d7afbf88d8b93b953c52af556fbabe5aed8c`  
**Observed functional source HEAD before this manifest commit:** `be870f246ddfe1a091c3d01e0756fcc77dbc47d4`
**Integration decision:** source-ready to push/merge as a fast-forward descendant; no push, merge, deployment, migration, credential, or provider action was performed or authorized in this slice.

## 1. Release artifact → intended integration paths

| Artifact | Intended live path | Integration constraint |
|---|---|---|
| This manifest | `RELEASE_INTEGRATION_MANIFEST.md` | Non-secret handoff only; it does not authorize external action. |
| Helmian Cloud source | Existing repository paths | Integrate the exact commit range below; do not copy sibling deployment snapshots. |
| Additive SQL migrations | `sql/009_envoy_chat.sql` through `sql/026_cora_connector_registrations.sql` | Apply in exact numeric order only after explicit live Neon authorization; not executed here. |
| Cora session descriptor | `src/cora/hume-session-descriptor.mjs` | Server-only preflight; no Hume mutation or acceptance claim. |
| Admin preflight route/panel | `src/cloud/live-admin.mjs`, `web/cloud-admin/*` | Membership-derived Organization; no client tenant, Plant, provider, or model selector. |

## 2. Exact local ancestry and commit range

Measured locally with `git log --reverse origin/release/maestro-workspace-2026-08-12..HEAD`. The local origin ref is the merge base, so there is no observed divergence requiring conflict resolution. The functional source range `c728d7a..be870f2` contains 52 commits. This manifest is the subsequent metadata-only commit; after it, the complete branch range is 53 commits: those 52 functional commits plus this manifest.

```text
a5c2eeb repair cloud readiness contract drift
51d7f7a add authenticated Envoy tenant chat path
40ad7d0 add fake Slack inbound connector gateway
cb33a0a wire authenticated Envoy composer
c2ce753 add authenticated Envoy polling cursor
7b1c74a add fake Discord inbound connector
fda813f add source-only Cora organization config
4c8a5bf add durable Cora organization config foundation
5c1631a add authenticated Cora settings UI
d68f6f3 add tenant provider usage ledger contract
76cd412 add read-only usage panel to cloud admin
8fce0b5 record verified Cora session usage outcomes
eddfe2f add source-only release canary validator
1c9e732 add tenant workspace preview intent receipts
50780c1 wire workspace preview intent web panel
9d5fd88 add tenant agent task intent receipts
b1cffd5 add provider-free worker task claims
8453ff6 modernize authenticated cloud workspace shell
a189d38 add cited Organization knowledge query
dc1a79e Add provider-free knowledge execution adapter contract
739bcc4 Add authenticated Envoy SSE stream
b91eb19 Harden authenticated admin and Envoy streams
1af39a2 Add resilient Envoy stream reconnect
3cb3870 Add local Cloud UI browser QA scaffolding
2769bd4 Add source-only Artifact Studio receipts
53f8af7 Add Artifact Studio source registry links
f3c061d Add Artifact Studio script revisions
0781d29 Add Artifact Studio execution preflight
b65b48f Exercise artifact execution HTTP harness
99be824 Add Cora personal preferences
251f669 Add Cora routing policy contract
7e7d8e3 Enforce Cora routing at execution boundary
84daaca Add Organization database routing seam
b682b8b Add authenticated workspace layout preferences
8c850db Wire role-aware workspace defaults
2c8beab Polish Cora personal controls
8d080cb Add structured Cora policy editor
a78e13c Add curated Cora knowledge management
5130b1f Add Organization usage budget controls
dc42bdf Add Organization approvals inbox
03e25d8 Add connector administration metadata
df33a32 Expose verified inbound connector routes
6d6b1ea Add Organization audit analysis workspace
e40cb82 Add Organization role planning workspace
cd0207a Add Organization readiness dashboard
18fc9af Add Cora capability explorer
a688119 Add bounded Organization audit export
d4f04a0 Resolve published Cora config per signed session
4903e32 Record signed Cora session lifecycle receipts
f31df7c Add Cora session history shelf
ba2950c Add Cora Hume session descriptor preflight
be870f2 Expose Cora Hume preflight visibility
```

Post-manifest source gate: `fbd0cb9` adds the executable local source-integrity
check. The current branch is 54 commits ahead of the observed local origin ref:
the 52 functional commits above, this manifest commit, and `fbd0cb9`. The gate
verifies the required 009–026 migration set and required Cora/Cloud source seams;
it does not inspect Git, Neon, Fly, Hume, credentials, providers, or deployed state.

## 3. Additive migration order

The source contains this exact ordered set; the release validator carries the required order in `src/cloud/release-canary-contract.mjs:2-20`.

```text
009_envoy_chat.sql
010_cora_organization_config.sql
011_cora_provider_usage.sql
012_cora_workspace_preview_intents.sql
013_cora_agent_task_intents.sql
014_cora_agent_task_claims.sql
015_cora_knowledge_retrieval_metadata.sql
016_cora_artifact_studio_intents.sql
017_cora_artifact_sources.sql
018_cora_artifact_script_revisions.sql
019_cora_artifact_execution_requests.sql
020_cora_personal_preferences.sql
021_organization_database_registry.sql
022_workspace_layout_preferences.sql
023_cora_knowledge_management.sql
024_cora_usage_budget_allocations.sql
025_cora_approval_decisions.sql
026_cora_connector_registrations.sql
```

No migration was executed against Neon. The migration list is not evidence that a live database has those migrations.

## 4. Current verification evidence

| Check | Evidence | Result |
|---|---|---|
| Full test suite | `npm test` at `be870f2` | 1,257 total; 1,255 passed; 0 failed; 2 skipped because `HELMION_ADMIN_CONFIG_TEST_DATABASE_URL` is not configured. |
| Focused route/client/shell suite | `node --test test/clm-live-admin.test.mjs test/cora-config-client.test.mjs test/cloud-admin-shell.test.mjs` | 44 passed; 0 failed. |
| Cloud syntax | `npm run check:cloud-admin` | Passed. |
| Diff/tree | `git diff --check`, `git status --short` before this manifest | Clean before this manifest; this manifest is the only current uncommitted file until the atomic commit below. |

The two skipped database tests are not live-database evidence. Browser visual tests remain local scaffolding unless a browser runtime is explicitly run.

## 5. Full traced source chain: Organization Cora session/Hume preflight

1. Same-origin client call: `web/cloud-admin/cora-config-client.mjs:76`.
2. Panel load/render: `web/cloud-admin/app.js:356-375` and `web/cloud-admin/index.html:180-185`.
3. Fixed route: `src/cloud/live-admin.mjs:99,850`.
4. All query parameters are rejected at `src/cloud/live-admin.mjs:852`; no client tenant, Plant, provider, model, or configuration selector exists.
5. Active membership and tenant transaction are derived at `src/cloud/live-admin.mjs:315-333`.
6. The server-owned preflight seam is called at `src/cloud/live-admin.mjs:854`.
7. The default seam passes process Hume reference and an explicit server readiness boolean at `src/cloud/live-admin.mjs:265-269`.
8. Published config resolution flows through `src/cora/hume-session-descriptor.mjs:77-79` to `src/cora/session-config-resolver.mjs:23-52`, which rejects unverified, ambiguous, unpublished, mismatched, invalid, or multi-voice-profile state.
9. Descriptor compilation validates professional bounds/readiness and emits version, voice, behavior, and hashes at `src/cora/hume-session-descriptor.mjs:44-75`.
10. Missing Hume reference or false readiness produces `state: unavailable`; Hume acceptance remains `not_verified` at `src/cora/hume-session-descriptor.mjs:63-65`.
11. The route sends admins bounded detail and members status-only detail at `src/cloud/live-admin.mjs:856-858`; it does not call or mutate Hume.

## 6. Full traced source chain: signed-session observability

1. Signed sessions resolve the published Organization config at `src/cora/clm-server.mjs:449-455`.
2. Started lifecycle receipt is attempted before admission at `src/cora/clm-server.mjs:512-514`.
3. Failed resolution and close outcomes are recorded at `src/cora/clm-server.mjs:455,575`.
4. Read-only history is exposed at `src/cloud/live-admin.mjs:842-847` and rendered by `web/cloud-admin/app.js:368-371`.

This is source/test evidence only. No physical signed session has been run against a deployed canary in this handoff.

## 7. Full traced source chain: Envoy inbound connector prerequisites

1. Public routes verify raw Slack/Discord input before persistence at `src/cloud/live-admin.mjs:526-532`.
2. Provider-specific signature verification is at `src/cloud/communication-connectors.mjs:36-54`.
3. Exact identity/channel/Organization binding is in `src/cloud/connector-gateway.mjs:22-76`.
4. Accepted events persist through the Envoy append path at `src/cloud/live-admin.mjs:532`; replay/idempotency is covered by connector tests.

Source supports tested fake-provider inbound paths. It does not prove a live webhook, outbound response, OAuth flow, credential vault, or provider delivery.

## 8. No-live claims and external gates

Not performed: `git push`, merge, Fly deploy, Fly secret/config change, live Neon migration/write, Hume API/config mutation, Hume credential installation, OAuth/Clerk mutation, Slack/Discord provider call, outbound delivery, billing, or credential rotation.

Required external gates:

1. Explicitly authorize push/merge of `c728d7a..be870f2`.
2. Verify deployed source commit and UI bundle revision.
3. Confirm Neon migrations 009–026 and required RLS policies in live state; do not infer from source.
4. Confirm exactly one current published Cora config per target Organization.
5. Configure and verify a server-only Hume credential/config reference without exposing its value.
6. Confirm Hume can reach deployed CLM and separately verify Hume acceptance; preflight is not acceptance.
7. Confirm connector registration, enabled lifecycle, signing-secret resolution, public routing, and exact active identity/channel bindings.
8. Confirm deployed OIDC/session/membership and cross-Organization negatives.

## 9. Exact physical canary and rollback sequence

Source contract: `src/cloud/release-canary-contract.mjs:22-40`.

```text
verify-release-manifest
verify-readiness
deploy-canary
health-check
authenticated-organization-read
normal-read-prepare
provider-session-receipt-check
observe
rollback-on-criteria
```

Rollback criteria:

```text
health_or_auth_failure
migration_mismatch
cross_organization_access
usage_receipt_duplicate_or_missing
provider_session_claim_without_source_receipt
```

The canary must preserve low-friction normal read/navigation/prepare and step up only high-risk external or irreversible work. Provider-connected or accepted claims without source-backed evidence are rollback conditions.

## 10. Approval boundary

The source tree is ready to push/merge based on measured fast-forward ancestry, the clean pre-manifest tree, focused tests, and full-suite result. Exact approval still needed: authorization for the external release sequence and separately for server-side Hume, Neon, Fly, OIDC/OAuth, and connector credential/config changes. Passing source tests and this manifest do not imply those approvals.
