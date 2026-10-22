// Registered promote targets: the ONLY places promote_build may ship to.
//
// Registration is the role gate. Executive Guard decides who may approve at
// all (approver tokens — today exactly one principal, "troy"). This registry
// narrows it per target: the executor additionally requires the signed
// decision's decidedBy to hold an admin/owner role FOR THAT TARGET, and
// refuses the push otherwise (fail closed, outcome reported to Guard).
//
// Adding a target, widening a role, or pointing a site at another repo is a
// code change here — reviewed like any other change, never a runtime input.

import { PROMOTE_SITE } from '../shared/protocol.mjs';

export const PROMOTE_TARGETS = Object.freeze({
  [PROMOTE_SITE]: Object.freeze({
    site: PROMOTE_SITE,
    repo: 'troy83352/forge-tms',
    baseBranch: 'main',
    // principal -> roles held for this target. A decision counts only when
    // the approver holds 'owner' or 'admin' here.
    approverRoles: Object.freeze({
      troy: Object.freeze(['owner', 'admin']),
    }),
  }),
});

export function targetForSite(site) {
  return PROMOTE_TARGETS[site] || null;
}

/** True only when `decidedBy` holds admin or owner for the target behind `site`. */
export function approverCoversTarget(site, decidedBy) {
  const target = targetForSite(site);
  if (!target || typeof decidedBy !== 'string' || !decidedBy) return false;
  const roles = target.approverRoles[decidedBy] || [];
  return roles.includes('owner') || roles.includes('admin');
}
