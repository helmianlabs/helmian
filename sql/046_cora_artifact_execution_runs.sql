-- Artifact execution run receipts: durable per-request outcomes written by the
-- cloud worker when it picks up an approved artifact execution request.
-- Mirrors helmion.cora_agent_task_runs. The requests table stays append-only
-- (a trigger rejects UPDATE/DELETE); runs are the execution record. Nothing
-- here invokes a provider, model, or filesystem — an approved request is
-- recorded as needs_desktop because external_execution is always true and the
-- provider call happens on the paired Helmian desktop (or a future runner).
create table if not exists helmion.cora_artifact_execution_runs (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  execution_request_id bigint not null references helmion.cora_artifact_execution_requests(id) on delete cascade,
  request_receipt_id text not null check (char_length(request_receipt_id) between 8 and 256),
  decision_receipt_id text not null check (char_length(decision_receipt_id) between 8 and 256),
  worker_id text not null check (char_length(worker_id) between 1 and 128),
  outcome text not null check (outcome in ('needs_desktop', 'failed', 'refused')),
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, execution_request_id)
);

create index if not exists cora_artifact_execution_runs_tenant_time_idx
  on helmion.cora_artifact_execution_runs(tenant_id, created_at desc, id desc);
