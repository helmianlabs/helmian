# Your hooks are wired

The installer merged the agent OS hook entries into your hooks file
for you:

    {{SETTINGS_PATH}}

Mistral Vibe reads its hooks from a TOML file as `[[hooks]]` tables, so
the entries the installer owns live in one delimited section of that
file, between these two marker lines:

    # BEGIN AGENT OS HOOKS
    # END AGENT OS HOOKS

Inside the section are two hooks: `agent-os-session-start` (type
`session_start`), which injects the core rules and your pending
captures at the start of every session, and `agent-os-turn-capture`
(type `{{TURN_END_EVENT}}`), which captures this session's learnings
when a turn ends. Everything outside the markers in your hooks file
was left exactly as it was — the merge refreshes the section it owns
and never overwrites your own hooks.

The exact section the installer merges is kept beside this sheet:

    {{SNIPPET_PATH}}

To check the wiring, open the hooks file and look for the two hook
names between the markers: `agent-os-session-start` and
`agent-os-turn-capture`.

To remove the wiring, delete everything from the `# BEGIN AGENT OS
HOOKS` line to the `# END AGENT OS HOOKS` line. The snippet and the
hook scripts can stay on disk; without the section, nothing runs.

## When the merge could not run

If the markers in your hooks file are in a shape the installer cannot
prove it owns — a BEGIN with no END after it, or more than one pair —
the installer leaves the file untouched and reports the skip, and the
hooks are NOT wired in that case. To wire them by hand, open the
snippet file above and copy its whole section, markers included, into
your hooks file. Do not replace the whole file — your own hooks live
in it too.
