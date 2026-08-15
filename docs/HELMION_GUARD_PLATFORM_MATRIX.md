# Helmion Guard supported-platform matrix (Phase 1/2)

This matrix describes packaging compatibility only. It is not a store listing,
enterprise certification, VPN-control claim, or proof of a live installation.

## Browser packages

| Target | Package | Current status | Signing/distribution boundary |
| --- | --- | --- | --- |
| Chrome | Chromium MV3 `extension/manifest.json` | Supported source shape; test with Chrome's unpacked loader first | Chrome Web Store submission is a separate approved action |
| Microsoft Edge | Chromium MV3 | Expected compatible with the Chromium package | Edge Add-ons submission is separate; no submission performed |
| Brave | Chromium MV3 | Expected compatible with the Chromium package | Unpacked install or Brave-compatible store policy; no store claim |
| Opera | Chromium MV3 | Expected compatible with the Chromium package | Opera add-on policy may differ; no submission performed |
| Vivaldi | Chromium MV3 | Expected compatible with the Chromium package | Unpacked install or Vivaldi distribution policy; no submission performed |
| Firefox | Separate `extension/manifest.firefox.json` | Scaffolded separately because Firefox uses `background.scripts` rather than Chromium's service-worker manifest shape | AMO signing/web-ext build required; the placeholder Gecko ID must be replaced by the owned add-on ID before submission |

The Chromium package is staged with `npm run guard:package:chromium`; the
Firefox package is staged with `npm run guard:package:firefox`. Both commands
write only to ignored local `artifacts/` directories and print the selected
manifest, permissions, host matches, and signing boundary. They do not upload,
sign, or contact a browser store.

## Permission and compatibility boundary

Both manifests request only `storage` and match the four supported AI hosts.
Neither package requests `<all_urls>`, host permissions, tabs, scripting,
downloads, identity, native messaging, or unlimited storage. The extension's
local scanner and redaction path have no outbound provider dependency.

## VPN integrations are separate

Helmion Guard does **not** provide universal VPN support and does not control a
VPN from the browser extension. Browser extension APIs cannot create or manage a
WireGuard/OpenVPN tunnel by themselves.

| Integration boundary | Feasible target | Status |
| --- | --- | --- |
| OS-managed WireGuard/OpenVPN profile | A separately installed, signed native helper or OS MDM/profile | Not implemented; requires an explicit native-helper/security review |
| Browser proxy configuration | Chromium/Firefox proxy APIs, if separately permissioned | Not requested; would expand permissions and is not a VPN tunnel |
| Provider-specific VPN API | A provider's documented control-plane API | Not selected; credentials, network, and retention review required |

Any future VPN work must name one protocol/provider, define the native or
control-plane boundary, and receive separate approval. No current build claims
VPN control or tunnel state.
