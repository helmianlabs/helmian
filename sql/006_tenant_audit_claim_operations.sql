-- Idempotent acknowledgement/release records for tenant-scoped outbox claims.

create table if not exists helmion.audit_outbox_operations (
  tenant_id text not null references helmion.tenants(tenant_id),
  idempotency_key text not null
    check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  operation_type text not null check (operation_type in ('ACK','RELEASE')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  claim_token uuid not null,
  actor_subject text not null check (nullif(trim(actor_subject), '') is not null),
  actor_role text not null check (actor_role in ('owner','admin','member','auditor')),
  session_id text not null check (nullif(trim(session_id), '') is not null),
  request_id text not null check (nullif(trim(request_id), '') is not null),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, idempotency_key)
);

create index if not exists audit_outbox_operations_claim_idx
  on helmion.audit_outbox_operations(tenant_id, claim_token, created_at desc);

alter table helmion.audit_outbox_operations enable row level security;

drop policy if exists audit_outbox_operations_current_context on helmion.audit_outbox_operations;
drop policy if exists audit_outbox_operations_current_context_read on helmion.audit_outbox_operations;
drop policy if exists audit_outbox_operations_current_context_insert on helmion.audit_outbox_operations;
create policy audit_outbox_operations_current_context_read on helmion.audit_outbox_operations
  for select
  using (tenant_id = current_setting('helmion.tenant_id', true));
create policy audit_outbox_operations_current_context_insert on helmion.audit_outbox_operations
  for insert
  with check (tenant_id = current_setting('helmion.tenant_id', true));
