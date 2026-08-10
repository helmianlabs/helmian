# Cora desktop workflow studio

`src/cora/desktop-workflow-studio.mjs` turns a small allowlisted catalog of
department templates into ready-to-render sample page or workflow definitions.
It is Cora's next desktop "hands" seam: operational, dispatch, fleet, load,
safety, HR, payroll, document, finance, integration, and approval workflows
all have concrete sample panels and typed steps instead of empty placeholders.

The multi-board load workflow is one normalized desktop definition: its sample
adapter panel represents several provider families behind one result list, and
its handoff state remains sample-only. The driver-mobile handoff template
models the governed desktop-to-driver transition with an explicit pending
confirmation/approval posture. Neither template selects a real provider,
sends a load, opens a mobile app, or crosses tenant scope.

Only an asserted owner or admin within one authorized tenant may create a
sample preview. The input must select one fixed department/template pair and
either `sample-page` or `sample-workflow`; free-form pages, code, fields,
payloads, credentials, and cross-tenant requests are refused.

Every successful result contains a deterministic sample definition, a
tenant/role-bound audit reference, the existing desktop-page projection, and
explicit `persistence: "not_performed"`, `execution: "not-wired"`,
`authorization: "not_evaluated"`, and `invocation: "not_performed"` markers.
Payroll, finance, and approval templates preserve pending confirmation and
approval gates.

The current Helmian desktop shell can identify existing pages such as Overview,
Activity, Workspace, Integrations, Settings, Console, and Approvals. Freight,
driver, safety, HR, payroll, finance, and other product screens return an
explicit `awaiting-desktop-surface` state until their actual desktop modules
are built. A future authorized desktop host can render these deterministic demo
definitions and invoke separately governed controls; it must not treat this
factory as authority to persist, navigate, mutate, notify, or contact a real
provider.
