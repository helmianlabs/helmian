# Cora authority and capability model

## Product intent

Cora is the voice interface for the whole AimForge/Helmian system. She is not
supposed to be a read-only narrator or a six-command chatbot. She should be
able to understand the full TMS, navigate every approved page, search records,
create and update things, run workflows, communicate across departments, and
help build new pages and policies.

The restriction belongs to the requesting human's authority, not to an
artificially tiny Cora persona. Cora may use any registered capability that the
current caller is allowed to use. Helmian is the enforcement point.

## Effective authorization

Every action is evaluated as:

`human subject + acting role + tenant + resource scope + action + current state + delegation/approval + Cora session`

The model never supplies tenant, role, user, assignment, provider, URL, or
approval authority. Those values come from the verified human session and live
server data. A signed Cora session is a short-lived delegation of the caller's
authority, not an administrator credential.

Helmian should combine:

- **RBAC:** owner, admin, dispatcher, supervisor, safety, payroll, driver,
  auditor, and other reviewed roles;
- **ABAC:** tenant, plant, department, assigned loads, equipment type, record
  state, action risk, time window, employment/status attributes, and current
  session surface;
- **ReBAC/resource checks:** whether the caller actually owns, manages, is
  assigned to, or is allowed to act on the requested record;
- **delegation:** a manager or owner can approve a specific bounded request
  without making the employee an administrator.

## Capability classes

The final catalog is broad and page-aware. It is not limited to the current
bootstrap six hands.

1. **Read and explain:** understand pages, search loads, inspect records,
   retrieve policy/SOP knowledge, summarize billing, explain safety rules.
2. **Navigate:** open an allowlisted AimForge/Helmian page or record. The
   browser receives a typed route intent, never arbitrary JavaScript or a URL.
3. **Reversible work:** draft pages, policies, billing changes, dispatch plans,
   internal messages, and workflow edits; show a diff and keep rollback data.
4. **Authorized writes:** execute changes when the caller's live RBAC/ABAC
   decision allows the action and the resource is in scope.
5. **Step-up approval:** require a named approver when policy, financial,
   external-communication, personnel, compliance, safety, or irreversible
   impact exceeds the caller's standing grant.
6. **Build mode:** help an authorized owner/developer create a page, workflow,
   skill, or integration through a reviewed builder surface. Generated code and
   schema changes remain subject to review, tests, audit, and deployment gates.

Approval is not required for every low-risk action. It is required when the
policy says the requested impact exceeds the caller's authority or the action
cannot be safely rolled back.

## Driver Cora

Driver sessions are scoped to the signed driver's current assignment and the
server-approved equipment workflow. Cora can explain procedures, look up
approved guidance, walk the driver through a check, record a valid result, and
request supervisor help. She cannot invent a clearance, bypass an evidence
requirement, release a hold, or act on another tenant/load.

## Current implementation gap

The current Helmian code has the correct identity/policy foundation and six
reviewed AimForge actions, but it is still a bootstrap catalog. Browser Hume
tool calls are intentionally refused until the signed action route and typed
navigation bridge are wired. The next implementation must expand the catalog
and route every action through the same live authorization, audit, replay, and
receipt path.

## Reference comparison

If “Alby” means alby.com, its public documentation describes agents attached to
an Experience and capabilities enabled through Actions. That is useful as a
front-door/product pattern, but it is not the complete enterprise authorization
model needed here: [Alby agents](https://help.alby.com/help/agents),
[Alby actions](https://help.alby.com/help/actions).

Alibaba Cloud's Agent ID documentation is closer to the security pattern: it
separates inbound client permission, outbound service permission, and the
identity chain connecting them. Helmian should follow that separation rather
than granting Cora a permanent administrator token:
[Alibaba Agent ID permission management](https://www.alibabacloud.com/help/en/idaas/user-guide/agent-permission-management).

## Non-negotiable invariants

- Cora can do anything the verified caller is authorized to do, not anything
  the model claims it can do.
- Every action returns a receipt or an explicit denial; spoken success without
  a receipt is a bug.
- Every read/write is tenant- and resource-scoped at the API/database layer.
- Provider identity, browser transport, and model choice never grant extra
  authority.
- Hume remains transport; Helmian remains the action router and policy gate.
- No generic shell, arbitrary browser control, arbitrary URL, or unrestricted
  database tool is exposed merely to make Cora appear powerful.
