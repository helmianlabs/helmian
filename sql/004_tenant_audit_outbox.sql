-- Tenant-scoped audit foundation.
--
-- This migration is intentionally additive. The pre-multi-user project/lease
-- tables are not retrofitted here because doing so without an authenticated
-- tenant mapping would either invent ownership or silently widen access.
-- New cloud-plane audit writes must use the transaction-local context below.

create table if not exists helmion.tenants (
  tenant_id text primary key
    check (tenant_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  display_name text not null
    check (nullif(trim(display_name), '') is not null),
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists helmion.tenant_memberships (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  subject text not null
    check (nullif(trim(subject), '') is not null),
  role text not null check (role in ('owner','admin','member','auditor')),
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, subject)
);

create table if not exists helmion.audit_events (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id),
  actor_subject text not null
    check (nullif(trim(actor_subject), '') is not null),
  actor_role text not null check (actor_role in ('owner','admin','member','auditor')),
  session_id text not null
    check (nullif(trim(session_id), '') is not null),
  request_id text not null
    check (nullif(trim(request_id), '') is not null),
  action_type text not null
    check (nullif(trim(action_type), '') is not null),
  canonical_target jsonb not null
    check (jsonb_typeof(canonical_target) = 'object'),
  policy_version text not null
    check (nullif(trim(policy_version), '') is not null),
  decision text not null
    check (decision in ('AUTO_RUN','ALLOW','PAUSE_FOR_OWNER','BLOCK','DENY')),
  before_ref jsonb,
  after_ref jsonb,
  privacy_summary text not null
    check (nullif(trim(privacy_summary), '') is not null),
  result jsonb not null default '{}'::jsonb
    check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists audit_events_tenant_time_idx
  on helmion.audit_events(tenant_id, created_at desc, id desc);

create table if not exists helmion.audit_outbox (
  event_id bigint primary key references helmion.audit_events(id) on delete restrict,
  tenant_id text not null references helmion.tenants(tenant_id),
  delivery_attempts integer not null default 0
    check (delivery_attempts >= 0),
  available_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  last_error text,
  constraint audit_outbox_delivery_state check (
    (delivered_at is null)
    or (delivered_at is not null and last_error is null)
  )
);

create index if not exists audit_outbox_pending_idx
  on helmion.audit_outbox(tenant_id, available_at, event_id)
  where delivered_at is null;

create or replace function helmion.enqueue_audit_event()
returns trigger
language plpgsql
as $$
begin
  insert into helmion.audit_outbox(event_id, tenant_id)
  values (new.id, new.tenant_id);
  return new;
end;
$$;

drop trigger if exists audit_events_enqueue_outbox on helmion.audit_events;
create trigger audit_events_enqueue_outbox
  after insert on helmion.audit_events
  for each row execute function helmion.enqueue_audit_event();

create or replace function helmion.reject_audit_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'helmion.audit_events is append-only';
end;
$$;

drop trigger if exists audit_events_append_only on helmion.audit_events;
create trigger audit_events_append_only
  before update or delete on helmion.audit_events
  for each row execute function helmion.reject_audit_event_mutation();

alter table helmion.tenants enable row level security;
alter table helmion.tenant_memberships enable row level security;
alter table helmion.audit_events enable row level security;
alter table helmion.audit_outbox enable row level security;

drop policy if exists tenants_current_context on helmion.tenants;
create policy tenants_current_context on helmion.tenants
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists memberships_current_context on helmion.tenant_memberships;
create policy memberships_current_context on helmion.tenant_memberships
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));

drop policy if exists audit_events_current_context on helmion.audit_events;
create policy audit_events_current_context on helmion.audit_events
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (
    tenant_id = current_setting('helmion.tenant_id', true)
    and actor_subject = current_setting('helmion.actor_subject', true)
  );

drop policy if exists audit_outbox_current_context on helmion.audit_outbox;
create policy audit_outbox_current_context on helmion.audit_outbox
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
