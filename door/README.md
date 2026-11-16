# The door

The OAuth door: one authorization server + MCP facade that fronts the
backends (shared memory, hands) behind a passphrase consent page, plus
the owner's approvals page for Guard decisions.

Pulled into the repo 2026-11-16 from the live box deployment
(/opt/helmian-door/app, container image helmian-door:1.0.3-sessionttl,
serving connect.helmian.cloud on 127.0.0.1:8099) as stage 1 of the
Scribe × Helmian separation, step 2 (split the door by move-over).
Live files only: the box's .bak files and the runtime state
(oauth-state.json, backend-tokens.json in the data directory) are not
part of the source and are not here. Source and comments were
secret-scanned before the pull-in; no credential values are in this
tree — all secrets arrive by environment at runtime (see
src/config.mjs for the variable list).

The split design: one codebase, two flavours (scribe and helmian),
separated by careful move-over — the new instance stands up in
parallel and callers move one by one, both products signing in at
every stage; the shared door narrows to Scribe-only last.
