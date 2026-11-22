# The door

Helmian's OAuth door: one authorization server + MCP facade that
fronts the hands backend behind a passphrase consent page, plus the
owner's approvals page for Guard decisions. It serves
door.helmian.cloud and fronts the hands backend only.

Scribe's door is a separate product: it stands on its own at
scribe.dairyforge.com, fronts the memory backend only, and runs from
Scribe's own source tree. It is not part of Helmian, and nothing in
this tree serves it. The old combined address, connect.helmian.cloud,
no longer answers — it was retired in the separation cutover of
2026-11-21.

Pulled into the repo 2026-11-16 from the live box deployment
(/opt/helmian-door/app, container image helmian-door:1.0.3-sessionttl,
then serving connect.helmian.cloud on 127.0.0.1:8099) as stage 1 of
the Scribe × Helmian separation, step 2 (split the door by
move-over). Live files only: the box's .bak files and the runtime
state (oauth-state.json, backend-tokens.json in the data directory)
are not part of the source and are not here. Source and comments were
secret-scanned before the pull-in; no credential values are in this
tree — all secrets arrive by environment at runtime (see
src/config.mjs for the variable list).

The split is complete (2026-11-21): the combined door is stopped,
Scribe's door stands up on its own address from its own tree, and
this tree is Helmian's door, running the `helmian` flavour.

## Flavours

`DOOR_FLAVOUR` selects which product's door an instance is:

- `combined` (the pre-split legacy shape, kept in the code from the
  move-over; not how the door runs now): both backends, all four
  scopes, the approvals page is Scribe's.
- `scribe`: the memory backend only, memory scopes only, the
  mailbox-status feed, Scribe's approvals page. Scribe's own door
  runs this flavour from Scribe's own source tree, not from here.
- `helmian`: the hands backend only, hands scopes only, Helmian's
  approvals page with Helmian's own Guard approver credential. This
  is the flavour Helmian's door runs in production.

The combined flavour's consent page and MCP instructions are
byte-identical to the pre-split code; the flavour tests live in
test/flavour.test.mjs (`npm test`).
