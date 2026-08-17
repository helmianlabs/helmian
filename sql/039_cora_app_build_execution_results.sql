-- Immutable worker outcome receipts for queued Cora app-build execution requests.
-- This ledger records evidence only; it never publishes, deploys, or invokes a provider or git.
create table if not exists helmion.cora_app_build_execution_results (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  execution_request_receipt_id text not null,
  revision_receipt_id text not null,
  approval_receipt_id text not null,
  workspace_project_key text not null,
  receipt_id text not null check (char_length(receipt_id) between 8 and 256),
  status text not null check (status in ('succeeded','failed')),
  verification jsonb not null check (jsonb_typeof(verification) = 'object'),
  generated_files jsonb not null check (jsonb_typeof(generated_files) = 'array'),
  failure_code text null check (failure_code is null or char_length(failure_code) between 1 and 120),
  rollback_action text null check (rollback_action is null or char_length(rollback_action) between 1 and 120),
  rollback_path text null check (rollback_path is null or rollback_path ~ '^generated-apps/[a-z0-9][a-z0-9-]{0,191}$'),
  execution text not null check (execution in ('performed','failed')),
  provider_invocation text not null default 'not_performed' check (provider_invocation = 'not_performed'),
  agent_invocation text not null default 'not_performed' check (agent_invocation = 'not_performed'),
  filesystem_mutation text not null check (filesystem_mutation in ('performed','not_performed')),
  publication text not null default 'not_performed' check (publication = 'not_performed'),
  deployment text not null default 'not_performed' check (deployment = 'not_performed'),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, execution_request_receipt_id), unique (tenant_id, receipt_id),
  foreign key (tenant_id, execution_request_receipt_id) references helmion.cora_app_build_execution_requests(tenant_id, receipt_id) on delete restrict,
  foreign key (tenant_id, revision_receipt_id) references helmion.cora_app_build_revisions(tenant_id, receipt_id) on delete restrict,
  foreign key (tenant_id, approval_receipt_id, revision_receipt_id) references helmion.cora_app_build_approval_decisions(tenant_id, receipt_id, revision_receipt_id) on delete restrict,
  foreign key (tenant_id, workspace_project_key) references helmion.workspace_projects(tenant_id, project_key) on delete restrict
);
create index if not exists cora_app_build_execution_results_tenant_time_idx on helmion.cora_app_build_execution_results(tenant_id, created_at desc, id desc);
create or replace function helmion.reject_cora_app_build_execution_result_mutation() returns trigger language plpgsql as $$ begin raise exception 'cora app build execution results are append-only'; end; $$;
create trigger cora_app_build_execution_result_append_only before update or delete on helmion.cora_app_build_execution_results for each row execute function helmion.reject_cora_app_build_execution_result_mutation();
alter table helmion.cora_app_build_execution_results enable row level security;
create policy cora_app_build_execution_results_tenant_select on helmion.cora_app_build_execution_results for select using(tenant_id=current_setting('helmion.tenant_id',true));
create policy cora_app_build_execution_results_tenant_worker_insert on helmion.cora_app_build_execution_results for insert with check(tenant_id=current_setting('helmion.tenant_id',true) and current_setting('helmion.actor_role',true) in ('owner','admin'));
