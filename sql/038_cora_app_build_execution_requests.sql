-- Tenant-scoped, append-only execution requests for a separately authorized worker.
-- Recording a request never invokes a worker, provider, filesystem, git, publication, or deployment.
alter table helmion.cora_app_build_approval_decisions
  add constraint cora_app_build_approval_receipt_revision_unique unique (tenant_id, receipt_id, revision_receipt_id);

create table if not exists helmion.cora_app_build_execution_requests (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  revision_receipt_id text not null,
  approval_receipt_id text not null,
  workspace_project_key text not null,
  receipt_id text not null check (char_length(receipt_id) between 8 and 256),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  status text not null default 'queued' check (status = 'queued'),
  requested_by_subject text not null check (char_length(requested_by_subject) between 1 and 256),
  requested_by_role text not null check (requested_by_role in ('owner','admin')),
  execution text not null default 'not_performed' check (execution = 'not_performed'),
  provider_invocation text not null default 'not_performed' check (provider_invocation = 'not_performed'),
  agent_invocation text not null default 'not_performed' check (agent_invocation = 'not_performed'),
  filesystem_mutation text not null default 'not_performed' check (filesystem_mutation = 'not_performed'),
  publication text not null default 'not_performed' check (publication = 'not_performed'),
  deployment text not null default 'not_performed' check (deployment = 'not_performed'),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, receipt_id), unique (tenant_id, idempotency_key),
  foreign key (tenant_id, revision_receipt_id) references helmion.cora_app_build_revisions(tenant_id, receipt_id) on delete restrict,
  foreign key (tenant_id, approval_receipt_id, revision_receipt_id) references helmion.cora_app_build_approval_decisions(tenant_id, receipt_id, revision_receipt_id) on delete restrict,
  foreign key (tenant_id, workspace_project_key) references helmion.workspace_projects(tenant_id, project_key) on delete restrict
);
create index if not exists cora_app_build_execution_requests_tenant_time_idx on helmion.cora_app_build_execution_requests(tenant_id, created_at desc, id desc);
create or replace function helmion.reject_cora_app_build_execution_request_mutation() returns trigger language plpgsql as $$ begin raise exception 'cora app build execution requests are append-only'; end; $$;
create trigger cora_app_build_execution_request_append_only before update or delete on helmion.cora_app_build_execution_requests for each row execute function helmion.reject_cora_app_build_execution_request_mutation();
alter table helmion.cora_app_build_execution_requests enable row level security;
create policy cora_app_build_execution_requests_tenant_select on helmion.cora_app_build_execution_requests for select using(tenant_id=current_setting('helmion.tenant_id',true));
create policy cora_app_build_execution_requests_tenant_admin_insert on helmion.cora_app_build_execution_requests for insert with check(tenant_id=current_setting('helmion.tenant_id',true) and current_setting('helmion.actor_role',true) in ('owner','admin') and requested_by_subject=current_setting('helmion.actor_subject',true) and requested_by_role=current_setting('helmion.actor_role',true));
