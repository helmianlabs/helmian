create table if not exists helmion.maestro_operations (
  id bigserial primary key,
  project_slug text not null references helmion.projects(slug) on delete cascade,
  idempotency_key text not null,
  operation_type text not null check (
    operation_type in ('ACQUIRE_LEASE','CREATE_CHECKPOINT','RELEASE_LEASE','TRANSFER_LEASE')
  ),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb not null,
  committed_at timestamptz not null default clock_timestamp(),
  unique (project_slug, idempotency_key)
);

create table if not exists helmion.maestro_leases (
  id bigserial primary key,
  lease_token uuid not null unique,
  project_slug text not null references helmion.projects(slug) on delete cascade,
  coordinator_id text not null check (coordinator_id ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'),
  holder_instance_id text not null,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE','RELEASED','TRANSFERRED','EXPIRED')),
  acquired_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  closed_at timestamptz,
  close_reason text,
  constraint maestro_lease_expiry_after_acquire check (expires_at > acquired_at),
  constraint maestro_closed_lease_has_time check (
    (status = 'ACTIVE' and closed_at is null)
    or (status <> 'ACTIVE' and closed_at is not null)
  )
);

create unique index if not exists maestro_one_active_lease_per_project_idx
  on helmion.maestro_leases(project_slug)
  where status = 'ACTIVE';

create index if not exists maestro_leases_project_history_idx
  on helmion.maestro_leases(project_slug, acquired_at desc);

create table if not exists helmion.project_checkpoints (
  id bigserial primary key,
  project_slug text not null references helmion.projects(slug) on delete cascade,
  lease_id bigint not null references helmion.maestro_leases(id),
  coordinator_id text not null,
  work_completed text not null check (nullif(trim(work_completed), '') is not null),
  files_changed jsonb not null check (jsonb_typeof(files_changed) = 'array'),
  test_results jsonb not null check (
    jsonb_typeof(test_results) = 'array' and jsonb_array_length(test_results) > 0
  ),
  open_blockers jsonb not null check (jsonb_typeof(open_blockers) = 'array'),
  unresolved_risks jsonb not null check (jsonb_typeof(unresolved_risks) = 'array'),
  next_safe_action text not null check (nullif(trim(next_safe_action), '') is not null),
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists project_checkpoints_latest_idx
  on helmion.project_checkpoints(project_slug, created_at desc, id desc);

create table if not exists helmion.maestro_handoffs (
  id bigserial primary key,
  project_slug text not null references helmion.projects(slug) on delete cascade,
  from_lease_id bigint not null references helmion.maestro_leases(id),
  to_lease_id bigint not null references helmion.maestro_leases(id),
  checkpoint_id bigint references helmion.project_checkpoints(id),
  from_coordinator_id text not null,
  to_coordinator_id text not null,
  status text not null check (status in ('COMPLETE','INCOMPLETE')),
  warning text,
  requires_human_confirmation boolean not null default false,
  confirmed_by text,
  confirmed_at timestamptz,
  payload jsonb not null,
  switched_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint maestro_handoff_checkpoint_state check (
    (
      status = 'COMPLETE'
      and checkpoint_id is not null
      and warning is null
      and requires_human_confirmation = false
    )
    or (
      status = 'INCOMPLETE'
      and checkpoint_id is null
      and nullif(trim(warning), '') is not null
      and requires_human_confirmation = true
    )
  ),
  constraint maestro_handoff_confirmation_pair check (
    (confirmed_by is null and confirmed_at is null)
    or (nullif(trim(confirmed_by), '') is not null and confirmed_at is not null)
  )
);

create index if not exists maestro_handoffs_latest_idx
  on helmion.maestro_handoffs(project_slug, created_at desc, id desc);

create table if not exists helmion.telemetry_events (
  id bigserial primary key,
  project_slug text references helmion.projects(slug) on delete cascade,
  coordinator_id text,
  holder_instance_id text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists telemetry_events_project_time_idx
  on helmion.telemetry_events(project_slug, created_at desc);
