# Helmian hosting and Cora hands plan

## End-state

Cora is the voice front door, not the authority layer. The intended path is:

`browser/mobile audio -> Hume transport -> Helmian CLM -> signed session + live policy -> bounded hand -> AimForge or browser event`

Helmian remains the only place that decides whether a hand is available. A
model provider, Hume, Discord, Slack, or the browser may request an action, but
none of them may choose a tenant, role, assignment, provider, URL, shell path,
or unrestricted record.

## Hands still to finish

1. **Navigation hand:** a fixed page allowlist (`operations`, `dispatch`,
   `loads`, `fleet`, `settings`, `admin`) returns a signed, typed UI intent.
   The browser verifies the intent and performs the tab change. Helmian must
   never receive arbitrary JavaScript, URLs, or DOM selectors.
2. **Connector webhook route:** wire the Discord/Slack verifier and signed
   connector bridge to live DB identity resolvers, global action policy, audit,
   replay, and the bounded runtime adapter. The source bridge is complete;
   public route wiring is intentionally still disabled.
3. **Envoy:** add authenticated channel/message routes and WebSocket fan-out
   over the `009_envoy_chat.sql` tenant-scoped schema. Agent turns must reuse
   the same signed-session bridge and policy; chat persistence alone is not an
   agent hand.

## Hosting decision

The current Fly deployment is the fastest path because Helmian Cloud and its
health checks already run there. Do not migrate merely because AWS is
available. Fly charges running Machines and does not promise a permanent free
tier for new organizations; Neon remains the managed database boundary.

AWS is a valid later host. Lightsail is the simplest VPS-like option for a
small Helmian test server; EC2 gives more control but requires more setup and
cost monitoring. AWS Activate may offset eligible AWS services and Bedrock
usage if the company qualifies, but it does not automatically provide Claude,
OpenAI, xAI, or Gemini API access. Each provider still needs its own approved
credential or supported Bedrock route.

Recommended sequence:

- Keep Helmian on Fly for source and integration testing.
- Apply for AWS Activate before moving anything; record the credit amount and
  expiry, then compare it with the actual Fly bill.
- If credits cover the test window, run a disposable Lightsail/EC2 staging
  instance, keep Neon unchanged, and prove backup/restore, signed-session
  health, policy disable, and rollback before considering migration.
- Never put provider keys in browser code, Discord/Slack payloads, Neon rows,
  or Cora prompts.

## Current truth

- Hume Custom-LM is the transport; saved Hume tools remain zero by design.
- Helmian owns the bounded action runtime.
- Browser Cora currently refuses unexpected Hume tool calls; navigation is a
  planned typed hand, not a finished live tab switch.
- No AWS migration, provider partnership, domain cutover, Clerk production
  cutover, APK build, or production safety activation is authorized by this
  document.
