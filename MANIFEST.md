# Channels-pane add-close fix — push manifest

Base for every hash below: **production HEAD
`2613df70f10795d35038f6c3475b8902a2cba635` PLUS the staged
boot-load tree** (`~/workspace/helmian-room-build/boot-load-20261111/push/`,
shell stamp `c0d6966f9644aeb0`, which already carries the
connect-paint changes). Both working trees for this bite
(`work/`, `control-src/`) were built by applying that push set to
the local repo copy at 2613df70 and verified byte-identical
against the staged files before any edit (envoy-workspace.js
`f99a958d…`, package.json `f074f55f…`).

This bite's shell stamp: **`e307c7eb47e83650`** (was
`c0d6966f9644aeb0` at the base), moved because
`app/envoy-workspace.js` changed; `scripts/shell-stamp.mjs`
rewrote 9 files and `--check` passes. The 8 stamp-carrying files
other than envoy-workspace.js are proven stamp-only: replacing
`e307c7eb47e83650` with `c0d6966f9644aeb0` in each reproduces the
base bytes exactly.

| file | base sha256 (2613df70 + boot-load tree) | new sha256 |
| --- | --- | --- |
| web/marketing/app/envoy-workspace.js | f99a958da4dce8f240a97ecf9575d7d8eb57753d0d5dd2cdbcb525d66baa23a2 | e85b5cc9add1c6189a2f7831f2de6fef0f33043321c6c3c8c4715b05cc71f597 |
| web/marketing/package.json | f074f55faeedf5f26d1c0fbaf47245dc49e2a96be23b6bf683ca324cdeb61c95 | cceeb5eaeaed461f88feab6beb6f8821b05158bed9e64e3b687d3bad3c26106a |
| web/marketing/test/app-channels-pane-add.test.mjs | — (new file) | 1867a4609a97719b879c36ad0e8127eccbc39c16655d00e260f36bc344e8a516 |
| web/marketing/app/index.html | 9125604ba28e6dbc1b76f631b1c4fb5438f18458049461cafb2e8bc3511d217e | 68dc5e49bdc51e796d9a2f0ee6e4babbe93b250d7ace9a4676ed09a9acc99e92 |
| web/marketing/app/app.js | 87c3f9021233319e4c02b8ebb161c06017815adcd95906b4c6d4d9d97e45b485 | cec4ad69914e01901e4059b26ddd860b1865e0d3e0576db8ad86749414d4ce36 |
| web/marketing/app/sw.js | d173d7d956b080a4fceb19c7a8263cc2cefe9a421eba2e5831155c0c7733e8a9 | 49f878c23eb57b3308c52245d8dbfeeb7971470bd061a2f1a0a3eccfb2ed21fb |
| web/marketing/app/account-menu.mjs | 3a3af52467158fa95e7d60f29491a94d342779b8e40086fbfa7018f5dd5e9b46 | f9a9d6c8b19e23e541304d81b166fdefd1f83ebbe37415d5ca24caf4a1bd8ed8 |
| web/marketing/app/api-key-fields.mjs | 2a9c573d6f6b2f50b9ef798ae34f563c7698eba167093389f17d5143cb786062 | 30f9b44d1da980172e4d8f0f7bd96b13b63695e9b81c4af4b4f4981a0fd121ff |
| web/marketing/app/composer-picker.mjs | 6b2447a066b1595987f2e374a0f3531feccb7cde7e33dd7c2e35a8d8e1f6b13e | c1f428f16cf17078cfa91ccb8a7bef0c8a91e74465bc65eb76ef9d881048fa39 |
| web/marketing/app/connector-menu.mjs | 9cfc24a776cddee1526fe2a9c013664fb8e71660bfb320e5067123c2798571b2 | 3b15f12aa1e86f84fcadd767675d58bd458a73ab2351902bc3f263a6bb1af346 |
| web/marketing/app/integrations-view.mjs | b76b3e87142a26f968843a5b03eb8451d814f43b125096de5c772411839f0ae8 | 171889373434a7e2a38d56f6aa99ce80eab32dc27319b69b305a2d0f81019e88 |

Content changes, per file:

- `web/marketing/app/envoy-workspace.js` — the fix, in
  `renderAgents` only (plus the exported pure helper it calls).
  Stamp-normalized diff vs the base is 39 lines and contains
  nothing else: the `addRenderKeepsPeek` helper (pushed line
  2042), the peek-trap comment + capture block (pushed lines
  2090–2095), and the one restore line (pushed line 2101).
- `web/marketing/package.json` — one line: the check script gains
  `test/app-channels-pane-add.test.mjs` (after
  `test/app-boot-load.test.mjs`, same precedent as the base's own
  bites).
- `web/marketing/test/app-channels-pane-add.test.mjs` — new, 3
  tests (peek decision, wiring + ordering, add-flow re-read).
- The other 8 files — stamp-only (proven above).

Push order note: this set is built ON the boot-load staged tree.
It must land AFTER (or folded into) the boot-load push, never
onto bare 2613df70 — its envoy base bytes are the boot-load
bytes.
