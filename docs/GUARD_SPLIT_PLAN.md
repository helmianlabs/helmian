# Guard split plan: separating Helmian Guard from Helmian

Status: **draft plan, nothing executed yet.** Troy approved writing this
plan and taking Guard off hold (Nov 17, 2026, 12:44 PM MT, by voice via
Paul). Each step below that touches production still needs its own yes.

"Guard" here means the browser extension (`extension/`) plus the
Executive Guard approval server (`executive-guard/`). Helmian Site Guard
(`src/cloud/site-guard.mjs`) is out of scope.

## Rules for every step
- Old and new run side by side until the last step. No step turns the old
  path off.
- Every change of behavior sits behind a flag or a build setting whose
  default is today's behavior.
- One step at a time. A step starts only when the steps it depends on are
  done and checked.
- Merges, releases, store publishing, production migrations and any server
  change need Troy's yes.

## Recorded versions (step 1, done in this doc)
- **Executive Guard source:** main's `executive-guard/` tree
  `72daed24812dafa5643ee90fedf140d9639578f2` (main at `5519e99`). On
  Nov 17, 2026, all 9 files running in the container (`src/*.mjs`,
  `bin/executive-guard.mjs`, `bin/auto-approve.mjs`) and the imported
  `extension/background/redact.js` hash-matched main byte for byte (sha256).
- **Running image:** `executive-guard:spokeproto-20261105`, image id
  `sha256:31b8c139dbf570fbb23c1bc5bede0686214537b4cfe1c371e7bac5893e7ba204`.
  The container was recreated Nov 16, 2026, 1:02 PM MT.
- **Correction:** `/opt/executive-guard/current-tag` on the box says
  `2d7a4f0`. No image with that tag exists on the box, and no commit
  `2d7a4f0` exists in this repo. The file is stale. The image above is
  the real one. (Fixing the file on the box is a server change and is not
  done here.)
- **Extension:** 0.7.0 on main. Its missing 0.6.3–0.6.8 work and PRs
  179/180/182/183 are ported in draft PRs #188 → #189 → #184 → #185 →
  #186 → #187 (they supersede #181).

## The ten steps

| # | Step | Size | Preconditions | Rollback |
|---|------|------|---------------|----------|
| 1 | Freeze and record versions (above) | S | none | records only |
| 2 | One Guard line: land the 0.7.0 port stack | M | Troy's yes to merge #188–#187 | revert the merge commits |
| 3 | Cut the shared code inside the monorepo | M | step 2 | revert; runtime unchanged |
| 4 | Guard gets its own package.json and build | S | step 3 | keep the root scripts until step 9 |
| 5 | Every address becomes a setting (default = today) | M | step 4 | defaults are unchanged |
| 6 | Guard's own storage, running alongside Helmian's | L | step 5 + Troy's yes (production migration) | turn the flag off |
| 7 | Executive Guard on its own on the server | M | steps 1 and 3 + Troy's yes (server) | point callers back at :8787 |
| 8 | Move Guard's approval page | M | step 7 + the door move | the old page stays up |
| 9 | Split the repo (e.g. `helmianlabs/guard`), keeping history | M | steps 3–8 | the monorepo copy stays |
| 10 | Retire the old paths | S | a quiet period with zero traffic on them + Troy's yes | re-enable them |

### Step 3: shared code to cut
- [`executive-guard/src/action.mjs:8`](https://github.com/helmianlabs/helmian/blob/5519e99/executive-guard/src/action.mjs#L8)
  imports `redactSensitivePrompt` from `../../extension/background/redact.js`.
  Move `redact.js` into a small `guard-core/` package that both import.
- [`extension/tools/sync-kernel.mjs:11`](https://github.com/helmianlabs/helmian/blob/5519e99/extension/tools/sync-kernel.mjs#L11)
  regenerates `extension/generated/` from live `src/core/`. Make it copy from
  a pinned kernel version instead.
- Tests that reach outside Guard need their own fixtures:
  [`executive-guard/test/injection.test.mjs:17-20`](https://github.com/helmianlabs/helmian/blob/5519e99/executive-guard/test/injection.test.mjs#L17)
  (extension + sync-kernel),
  [`executive-guard/test/hands-compat.test.mjs:11`](https://github.com/helmianlabs/helmian/blob/5519e99/executive-guard/test/hands-compat.test.mjs#L11)
  and `standing-grant-hands-e2e.test.mjs:14` (`hands-mcp/src/guard-client.mjs`),
  [`extension/test/kernel-sync.test.mjs:41`](https://github.com/helmianlabs/helmian/blob/5519e99/extension/test/kernel-sync.test.mjs#L41)
  and [`extension/test/claims-scan.test.mjs:18`](https://github.com/helmianlabs/helmian/blob/5519e99/extension/test/claims-scan.test.mjs#L18)
  (`src/core`).

### Step 4: build
- Today packaging runs from the monorepo root:
  [`package.json:28-29`](https://github.com/helmianlabs/helmian/blob/5519e99/package.json#L28),
  [`tools/package-guard.mjs:17`](https://github.com/helmianlabs/helmian/blob/5519e99/tools/package-guard.mjs#L17).
  `executive-guard/` has no package.json of its own. The zip name still
  says "helmion".

### Step 5: addresses to turn into settings
- [`extension/manifest.json:12-13`](https://github.com/helmianlabs/helmian/blob/5519e99/extension/manifest.json#L12): host
  permissions for helmian.cloud and connect.helmian.cloud.
- [`extension/background/upload.js:29`](https://github.com/helmianlabs/helmian/blob/5519e99/extension/background/upload.js#L29):
  helmian.cloud/api/guard/browser-events.
- [`extension/background/pc-approvals-client.js:65`](https://github.com/helmianlabs/helmian/blob/5519e99/extension/background/pc-approvals-client.js#L65):
  helmian.cloud.
- [`extension/background/approvals-client.js:53`](https://github.com/helmianlabs/helmian/blob/5519e99/extension/background/approvals-client.js#L53)
  and [`extension/popup/popup.js:355`](https://github.com/helmianlabs/helmian/blob/5519e99/extension/popup/popup.js#L355):
  connect.helmian.cloud.
- [`extension/popup/approvals-window.js:285`](https://github.com/helmianlabs/helmian/blob/5519e99/extension/popup/approvals-window.js#L285):
  helmian.cloud/app#approvals.
- [`test/guard-platform-matrix.test.mjs:20`](https://github.com/helmianlabs/helmian/blob/5519e99/test/guard-platform-matrix.test.mjs#L20)
  pins them.

### Step 6: Helmian database ties
- [`sql/047_guard_findings.sql`](https://github.com/helmianlabs/helmian/blob/5519e99/sql/047_guard_findings.sql),
  [`sql/083_site_guard_finding_source.sql`](https://github.com/helmianlabs/helmian/blob/5519e99/sql/083_site_guard_finding_source.sql),
  `src/cloud/guard-findings.mjs`.
- PC approvals through Helmian's admin API:
  [`src/cloud/guard-pc-approvals.mjs:20`](https://github.com/helmianlabs/helmian/blob/5519e99/src/cloud/guard-pc-approvals.mjs#L20),
  [`src/cloud/live-admin.mjs:114`](https://github.com/helmianlabs/helmian/blob/5519e99/src/cloud/live-admin.mjs#L114).
- Plan: write to both stores behind a flag, read from the old one until the
  counts match, then flip reads.

### Step 7: the shared Hetzner box (5.78.222.178)
- Executive Guard runs there at 127.0.0.1:8787 on the shared `helmian-net`
  network, next to hands-mcp, both doors, Scribe and the
  `executive-guard-auto-approve` systemd service.
- Helmian reaches it via `HELMIAN_GUARD_URL`
  ([`guard-pc-approvals.mjs:13`](https://github.com/helmianlabs/helmian/blob/5519e99/src/cloud/guard-pc-approvals.mjs#L13)).
  Both doors use `GUARD_URL=http://127.0.0.1:8787`.
- Plan: start a second container on a new port with its own signing key and
  tokens, then move callers one at a time.

## Door move (prerequisite for step 8)
connect.helmian.cloud (combined door, :8099) → door.helmian.cloud
(`helmian-door-helmian:1.0.0`, hands only, :8098). Both resolve to
5.78.222.178 and have valid Let's Encrypt certificates (checked Nov 17, 2026).
Only hands callers move; memory callers stay on connect. Order:
1. Tag each connect caller as memory or hands, using a per-client count (no tokens).
2. Helmian worker first: re-mint its token against door.helmian.cloud
   (`door/scripts/mint-*-token*.mjs`, behind an address flag).
3. ChatGPT and Gemini hands seats, then Claude, Codex, Mistral and Grok, one at
   a time, each with a re-consent.
4. Guard approvals page via the step 5 setting, plus the manifest host (needs
   a new build: Troy's yes).
5. Check per caller: the hands call works, the approval shows on the new door,
   and the old door's log goes quiet for that caller.
6. Last: `DOOR_FLAVOUR=scribe` on connect (Troy's yes). Rollback: drop the
   flag (combined is the default). Caddy backup:
   `Caddyfile.bak-20261116-door-split`.

Each door has its own state directory, so existing OAuth tokens most
likely won't carry over. That is inferred, not tested.
