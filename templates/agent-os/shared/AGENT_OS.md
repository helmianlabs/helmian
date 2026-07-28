# Agent OS — the full system

The complete description of the loop and the advisory lane. The core rules are
repeated here so this file stands alone: importing it delivers the whole system
even when the main context file already belonged to someone else.

Installed by `helmion agent-os install`. Files under `agent-os/` are managed by
the installer and may be rewritten when you reinstall. Everything outside
`agent-os/` is yours — the installer creates those once and never overwrites
them.

{{CORE_RULES}}

{{LOOP}}

{{ADVISORY}}
