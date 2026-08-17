-- Immutable, tenant-scoped GitHub App source bindings. This records verified
-- source identity only; it never stores a token/URL or performs checkout, git, publish, or deploy.
create table if not exists helmion.github_app_workspace_source_bindings (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  workspace_project_key text not null,
  provider text not null check (provider = 'github_app'),
  github_repository_node_id text not null check (char_length(github_repository_node_id) between 1 and 256),
  github_repository_id bigint not null check (github_repository_id > 0),
  github_owner text not null check (github_owner ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  github_repository_name text not null check (github_repository_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'),
  github_installation_id bigint not null check (github_installation_id > 0),
  default_branch text not null check (char_length(default_branch) between 1 and 160),
  base_commit_sha text not null check (base_commit_sha ~ '^[0-9a-f]{40,64}$'),
  verification_receipt_id text not null check (char_length(verification_receipt_id) between 8 and 256),
  vault_credential_reference text not null check (vault_credential_reference ~ '^vault://tenant/[A-Za-z0-9._:-]+/github-app/[A-Za-z0-9._:-]+$'),
  lifecycle text not null check (lifecycle = 'pending_verification'),
  receipt_id text not null check (char_length(receipt_id) between 8 and 256),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  bound_by_subject text not null check (char_length(bound_by_subject) between 1 and 256),
  bound_by_role text not null check (bound_by_role in ('owner','admin')),
  source_verification text not null default 'not_performed' check (source_verification = 'not_performed'),
  token_exchange text not null default 'not_performed' check (token_exchange = 'not_performed'),
  checkout text not null default 'not_performed' check (checkout = 'not_performed'),
  execution text not null default 'not_performed' check (execution = 'not_performed'),
  publication text not null default 'not_performed' check (publication = 'not_performed'),
  deployment text not null default 'not_performed' check (deployment = 'not_performed'),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, receipt_id), unique (tenant_id, idempotency_key),
  foreign key (tenant_id, workspace_project_key) references helmion.workspace_projects(tenant_id, project_key) on delete restrict
);
create index if not exists github_app_workspace_source_bindings_tenant_project_idx on helmion.github_app_workspace_source_bindings(tenant_id, workspace_project_key, created_at desc, id desc);
create or replace function helmion.reject_github_app_workspace_source_binding_mutation() returns trigger language plpgsql as $$ begin raise exception 'github app workspace source bindings are append-only'; end; $$;
create trigger github_app_workspace_source_binding_append_only before update or delete on helmion.github_app_workspace_source_bindings for each row execute function helmion.reject_github_app_workspace_source_binding_mutation();
alter table helmion.github_app_workspace_source_bindings enable row level security;
create policy github_app_workspace_source_bindings_tenant_select on helmion.github_app_workspace_source_bindings for select using(tenant_id=current_setting('helmion.tenant_id',true));
create policy github_app_workspace_source_bindings_tenant_admin_insert on helmion.github_app_workspace_source_bindings for insert with check(tenant_id=current_setting('helmion.tenant_id',true) and current_setting('helmion.actor_role',true) in ('owner','admin') and bound_by_subject=current_setting('helmion.actor_subject',true) and bound_by_role=current_setting('helmion.actor_role',true));
