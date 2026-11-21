-- Persist the Organization catalog title separately from the coarse server role.
-- Several catalog titles intentionally map to serverRole=member; without this
-- column a dispatcher and an operations_manager collapse into the same role.
alter table helmion.tenant_memberships
  add column if not exists job_title text;

create index if not exists tenant_memberships_job_title_idx
  on helmion.tenant_memberships(tenant_id, job_title);
