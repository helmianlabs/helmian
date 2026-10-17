-- Workspace write leases: mutual exclusion for cloud workers that hand work to
-- the desktop runner. One ACTIVE lease per (tenant, project); a second holder
-- cannot acquire while an unexpired lease exists. A stale (expired) lease may
-- be taken over. On any error or ambiguity the lease is treated as held —
-- fail-closed, never defaulting to free (the desktop rule "UNREADABLE is never
-- shown as NONE" applies here too).
--
-- project_key is NULLABLE: NULL means a tenant-scope lease, used when the work
-- item has no project of its own (e.g. artifact execution requests carry no
-- project key, so the artifact-execution worker leases at tenant scope).
-- A NULL project_key simply does not constrain the foreign key. Two partial
-- unique indexes enforce one ACTIVE lease per project and one ACTIVE
-- tenant-scope lease. Released/expired rows stay as history.
-- Nothing here touches a filesystem or invokes a provider.
create table if not exists helmion.workspace_write_leases (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  project_key text references helmion.workspace_projects(project_key) on delete cascade,
  holder text not null check (char_length(holder) between 1 and 256),
  lease_token text not null unique check (lease_token ~ '^[0-9a-f-]{36}$'),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'RELEASED', 'EXPIRED')),
  acquired_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  closed_at timestamptz,
  close_reason text,
  constraint workspace_lease_expiry_after_acquire check (expires_at > acquired_at),
  constraint workspace_closed_lease_has_time check (
    (status = 'ACTIVE' and closed_at is null)
    or (status <> 'ACTIVE' and closed_at is not null)
  )
);

create unique index if not exists workspace_one_active_lease_per_project_idx
  on helmion.workspace_write_leases(tenant_id, project_key)
  where status = 'ACTIVE' and project_key is not null;

create unique index if not exists workspace_one_active_tenant_lease_idx
  on helmion.workspace_write_leases(tenant_id)
  where status = 'ACTIVE' and project_key is null;

create index if not exists workspace_write_leases_history_idx
  on helmion.workspace_write_leases(tenant_id, project_key, acquired_at desc);
