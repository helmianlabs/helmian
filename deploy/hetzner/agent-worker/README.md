# Cloud agent worker — repo-side mirror of the Hetzner-only code

The always-on Envoy channel worker (providers gemini + grok) lives ONLY on
the Hetzner server at `/opt/helmian-agentbox/worker/` — it has no other
source of truth. This directory is its repo-side mirror, kept so the code
is reviewable and the next splice has a home. **The server copy is what
runs.** When one side changes, splice the other in the same bite and say
which side led.

| File | State |
| --- | --- |
| `agent-worker.mjs` | Byte-identical to the server's live copy (md5 `979d4f852d52cb9eed014b6ff106243f`, 2026-10-25). Changed by the tenant-discovery splice: it now reads `tenantId` from the pairing record (device-token.json) beside the token and passes it to `prepareJobMessage`. Before the splice it was md5 `8871346993955d684840736f30a401f6`; the channel-parity fix did not touch it. |
| `worker-park.mjs` | Byte-identical to the server's live copy (md5 `fefbf3542cd5900626f40159618c973c`). Unchanged. |
| `worker-attachments.mjs` | Byte-identical to the server's live copy (md5 `095a04d77978658a765745abed2aafca`, 2026-10-25). **FIXED here first** (channel-turn parity bite, 2026-10-25): the metadata normalizer now carries the `file` attachment kind with the canonical validator's rules (src/cloud/envoy-agents.mjs) and the context builder inlines text files / honestly lines images, mirroring src/agent/attachments.mjs. The tenant-discovery splice then taught `expandLeadingSlash`/`prepareJobMessage` an optional `tenantId`: discovery becomes the tenant-aware merge from `worker-tenant.mjs`; no tenant id → the exact single-workspace path. Deploy = copy this file over the server's `/opt/helmian-agentbox/worker/worker-attachments.mjs` and restart `helmian-agent-worker.service`. |
| `worker-tenant.mjs` | Byte-identical to the server's live copy (md5 `74cdf1018d7d91041748f813bbefc22b`). NEW (tenant-discovery splice, 2026-10-25): port of src/agent/tenant-workspace.mjs — maps a tenant to `<job workspace>/tenants/<tenantId>/`, stocks the starter commands additively on first use, and merges the tenant registry under the workspace's own (workspace wins clashes). Takes the dynamically loaded commands module instead of importing the repo's. |
| `starter-commands/` | The five starter commands (`draft`, `explain`, `plan`, `standup`, `summarize`), byte-identical to src/agent/starter-commands/ on feat/tenant-onboarding (md5s `8ccf3b27…`, `ba469227…`, `69268038…`, `f951e457…`, `2b5256e3…`). `worker-tenant.mjs` reads them from beside itself on the server. |
| `test-attachments.mjs` | The server's fixture proof, extended with the file fixtures (G–L), including fixture G — a replay of the 2026-10-24 live rehearsal whose 49-byte upload died on this path. Run: `node test-attachments.mjs` from this directory. |
| `original/` | The server copies as pulled on 2026-10-25, before the fix, for diffing. |

Why the fix had to live here: the bridge (src/agent/bridge.mjs →
src/agent/attachments.mjs) consumes file attachments on PC-bridge turns,
but channel turns answered by this worker go through
`worker-attachments.mjs`, whose replicated kind allowlist was still
`['skill', 'connector', 'plugin']` — a file made normalization throw, the
tolerant wrapper dropped the message's whole metadata, and the runner
(only ever shown the bare body) truthfully reported no attachment.

Tenant-discovery splice (2026-10-25, server-led — the server copies were
spliced first and this mirror updated to match in the same bite): the
onboarding branch's per-tenant command workspaces
(src/agent/tenant-workspace.mjs, used by bin/pc-bridge.mjs) reached the
PC bridge but not this worker, whose turns read only the single
hand-seeded workspace. Pre-splice server copies are the server's own
`*.bak-tenant-20261025-134754` backups. Proven on the server by fixture:
a synthetic tenant's workspace was created + stocked, a tenant-only
command expanded only with that tenant id, a vandalized tenant copy of
/draft lost to the workspace's own (base wins), and Troy's tenant
expanded byte-identically with and without the tenant path. What it does
NOT do yet: the mesh-side claim gate lives in the repo
(src/cloud/tenant-agent-state.mjs + envoy-mesh.mjs) and lands with the
landing wave; a real second tenant's live turn is UNVERIFIED — none
exists yet.
