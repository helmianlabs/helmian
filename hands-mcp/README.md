# helmian-hands-mcp

Remote MCP connector that lets an approved AI client (Claude.ai, ChatGPT, Grok, Maestro) act on Troy's PC
through the Helmian bridge. Design: `docs/hands/HANDS_MCP_CONNECTOR_DESIGN.md`.

**Live:** `https://hands.5-78-222-178.sslip.io/mcp` on the Hetzner box (5.78.222.178), container
`helmian-hands-mcp` on `127.0.0.1:8090`, behind the same Caddy as `claude-memory-mcp`.

## Safety model
| Layer | Rule |
|---|---|
| OAuth 2.1 + PKCE + DCR | Passphrase consent page (same passphrase as the memory connector). Scopes `hands.read`, `hands.act`. 5 wrong passphrases lock consent + pairing for 15 min. |
| Kill switch | `HANDS_ENABLED=false` in `/opt/helmian-hands-mcp/app.env` refuses every call. |
| Routing | `src/core/compute-routing.mjs`: PC-only work goes to the PC or nowhere. Hands calls are live-only; nothing is queued. |
| Read-only tools | `list_files`, `read_file`, `search_files`, `ollama_generate`, `hands_status`: allowed with `hands.read`, confined to the PC's workspace roots, secret-looking paths refused, 64 KB cap. |
| Mutating tools | `run_powershell` (allow-listed ids only), `open_url` (https), `write_file`, `move_file`, `copy_file` (both refuse an existing destination), `delete_file` (folders need `recursive: true`), `make_dir`, `edit_file`: need `hands.act` **and** a human-approved, Ed25519-signed Executive Guard decision bound to the exact arguments. Guard not configured, unreachable, slow, auto-allow, denied, expired or unverifiable = **deny**. |
| The PC | Re-verifies the Guard signature with a key pinned **on the PC** (`pin-guard`), single-use per decision. No pinned key = every mutating job refused even if the hub is compromised. Outbound-only long-poll; nothing listens on the PC. |
| Root grants | Folders outside the built-in roots are reachable only through signed root grants (`roots.grants.json` beside the spoke config): one absolute folder each, bound to this spoke's device id, verified against the same pinned Guard key on every load. Grants are **read-only** — mutating tools refuse under a granted root before the Guard decision is spent — and removing a grant revokes it immediately. No grant mechanism covers a whole drive or write access. Design + operator flow: `docs/hands/ROOT_GRANTS.md`. |
| Secrets | No provider keys (rule 019). Server holds only its OAuth state, hashed spoke tokens and the passphrase. |

## PC setup
```powershell
cd E:\Helmion   # your Helmian checkout
node bin\hands-spoke.mjs pair --roots "E:\Helmion"      # type the hands passphrase
# The HelmianBridge service starts the spoke automatically (restart the service), or run in the foreground:
node bin\hands-spoke.mjs
# When Executive Guard is live (until then mutating tools stay denied):
node bin\hands-spoke.mjs pin-guard <x from Guard GET /v1/keys>
# Read-only access to ONE folder outside the roots, after a human-approved root grant:
node bin\hands-spoke.mjs request-root "F:\AutoVector" --reason "read the new autovector build"
node bin\hands-spoke.mjs add-root-grant <grant.json>   # verifies the signed grant, then stores it
node bin\hands-spoke.mjs list-root-grants
node bin\hands-spoke.mjs revoke-root-grant <grantId>
```

## Deploy (on the box)
```bash
git archive HEAD | ssh root@5.78.222.178 'rm -rf /opt/helmian-hands-mcp/src && mkdir -p /opt/helmian-hands-mcp/src && tar -x -C /opt/helmian-hands-mcp/src'
ssh root@5.78.222.178 /opt/helmian-hands-mcp/src/hands-mcp/deploy.sh
```
Caddy block (in `/etc/caddy/Caddyfile`):
```
hands.5-78-222-178.sslip.io {
	reverse_proxy 127.0.0.1:8090
}
```

## Tests
`npm --prefix hands-mcp ci && npm --prefix hands-mcp test` (end-to-end tests over real HTTP: OAuth, routing, Guard mock with
the real envelope, PC executor, fail-closed cases, plus `test/root-grants.test.mjs` for signed read-only root grants).
