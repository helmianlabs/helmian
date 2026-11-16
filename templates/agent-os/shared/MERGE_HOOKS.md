# Your hooks are wired

The installer merged the agent OS hook entries into your settings file
for you:

    {{SETTINGS_PATH}}

The entries it added live under the `hooks` key: a SessionStart entry
that injects the core rules and your pending captures at the start of
every session, and a {{TURN_END_EVENT}} entry that captures this
session's learnings when a turn ends. Everything else in your settings
file was left exactly as it was — the merge adds the hook groups it
owns and never overwrites your own settings or your own hooks.

The exact entries the installer merges are kept beside this sheet:

    {{SNIPPET_PATH}}

To check the wiring, open the settings file and look for the two hook
commands under `hooks`: `session-start-context.mjs` and
`stop-capture.mjs`.

To remove the wiring, delete those two hook groups from the settings
file. The snippet and the hook scripts can stay on disk; without the
settings entries, nothing runs.

## When the merge could not run

If your settings file could not be read as JSON, the installer leaves
it untouched and reports the skip — the hooks are NOT wired in that
case. To wire them by hand, open the snippet file above and merge its
`hooks` object into the settings file: for each event name in the
snippet, append the snippet's hook groups to the array under the same
event name in your settings, creating the `hooks` object and the event
array first if they are not there. Do not replace the whole file —
your own settings live in it too.
