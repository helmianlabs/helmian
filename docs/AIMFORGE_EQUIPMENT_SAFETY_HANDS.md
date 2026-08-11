# AimForge equipment-safety hands

This release adds three Helmian actions for a signed AimForge mobile-driver voice session:

- `aimforge_get_equipment_safety_status`
- `aimforge_record_equipment_safety_check`
- `aimforge_request_safety_supervisor_review`

They are Helmian runtime hands, not Hume-attached tools. Hume receives no tool definitions for the custom-language-model configuration.

## Authority and scope

AimForge selects the only eligible current assignment from the verified Clerk-linked pool-driver identity. Zero assignments produces no safety focus; more than one fails closed. The signed bridge carries the resulting tenant, Clerk subject, driver role, mobile surface, and assignment focus. Helmian verifies that bridge, signs a fixed-path action request, and never accepts tenant, driver, assignment, equipment profile, citations, provider, or URL as model arguments.

AimForge re-verifies the raw bridge and request HMAC, claims a durable tenant/endpoint/nonce replay key, and re-runs the reviewed `resolveBoundSafetyContext` before every operation. That service rechecks active pool identity, verified tenant membership, assignment status, pickup tenant, equipment config, and frozen workflow. A stale or cross-tenant focus is rejected.

## Exact effects

The status hand idempotently begins/reuses the assignment-bound inspection and returns the frozen server manifest plus current bounded disposition/check status. The check hand calls the same `recordEquipmentSafetyCheck` production service as the reviewed button/voice routes with `recordedVia=VOICE`. The model cannot attach arbitrary evidence; defect checks that require assignment-owned photo evidence therefore fail with `EVIDENCE_REQUIRED` until the reviewed evidence path supplies it.

The supervisor-review hand maps one manifest-approved check to `NEEDS_HELP`. The reviewed safety transaction writes the item, inspection `HOLD`, assignment cannot-proceed reason, and hold ledger atomically. It is a review/hold request, not a notification-delivery claim.

There is deliberately no release, approval, send, provider, generic HTTP, shell, workspace, arbitrary-record, or hazmat-selection hand. Hazmat remains `409 HAZMAT_PROFILE_UNAVAILABLE`; hold release remains the separate human admin/supervisor route.

## Operations

All six fixed Helmian hands are governed by the platform-global, disable-only action policy. Migration `008_equipment_safety_action_policy.sql` adds the three safety flags, defaulting to enabled for release continuity. Policy reads fail closed. The live admin reports Hume-attached tools as zero and identifies the three driver-safety hands and their no-release boundary.

Required runtime configuration is unchanged: `HELMION_AIMFORGE_API_BASE_URL`, `HELMION_AIMFORGE_ACTION_SECRET`, and `HELMION_AIMFORGE_BRIDGE_SECRET`. Deploy AimForge first, apply Helmian migration 008, then deploy Helmian; do not enable the hands until both secrets match and the AimForge safety release is present.
