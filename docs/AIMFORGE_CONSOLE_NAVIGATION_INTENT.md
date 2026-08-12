# AimForge console navigation intent

`aimforge_create_console_navigation_intent` is a Helmian-side fixed action hand. It accepts only `page` with `dashboard`, `dispatch_board`, or `load_planner`. It sends the raw signed session bridge plus canonical HMAC proof to the fixed AimForge path. It accepts no URL, path, tenant, subject, or role.

AimForge returns a typed intent with `execution: not_executed`. Hume still has zero attached tools. Helmian can create the intent while answering a Custom-LM turn, but the current Hume reply protocol carries assistant text/audio rather than an out-of-band typed browser event, and the AimForge web client has no reviewed consumer. Cora must not say the page changed. A future browser consumer is a separate security boundary and release.

The platform-global action policy can disable this fixed tool for every signed customer session; it cannot introduce a new page or arbitrary tool.
