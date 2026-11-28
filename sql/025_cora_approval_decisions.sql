-- Durable Organization approval decisions over existing source-only receipts.
-- Decisions never execute a provider, worker, filesystem action, or external write.
create table if not exists helmion.cora_approval_decisions (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  request_kind text not null check (request_kind in ('artifact_execution_request')),
  request_receipt_id text not null check (char_length(request_receipt_id) between 8 and 256),
  decision text not null check (decision in ('approve','reject')),
  reason text not null check (char_length(reason) between 1 and 600),
  actor_subject text not null check (char_length(actor_subject) between 1 and 256),
  actor_role text not null check (actor_role in ('owner','admin')),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  receipt_id text not null check (char_length(receipt_id) between 8 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, request_kind, request_receipt_id),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, receipt_id)
);
create index if not exists cora_approval_decisions_tenant_time_idx on helmion.cora_approval_decisions(tenant_id, created_at desc, id desc);
create or replace function helmion.reject_cora_approval_decision_mutation() returns trigger language plpgsql as $$ begin raise exception 'helmion.cora_approval_decisions is append-only'; end; $$;
drop trigger if exists cora_approval_decisions_append_only on helmion.cora_approval_decisions;
create trigger cora_approval_decisions_append_only before update or delete on helmion.cora_approval_decisions for each row execute function helmion.reject_cora_approval_decision_mutation();
alter table helmion.cora_approval_decisions enable row level security;
drop policy if exists cora_approval_decisions_tenant_select on helmion.cora_approval_decisions;
create policy cora_approval_decisions_tenant_select on helmion.cora_approval_decisions for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_approval_decisions_tenant_insert on helmion.cora_approval_decisions;
create policy cora_approval_decisions_tenant_insert on helmion.cora_approval_decisions for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
