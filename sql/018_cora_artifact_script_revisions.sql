-- Manual Artifact Studio script/narration revisions. No generation, provider call,
-- media, prompt secret, credential, URL fetch, or file fetch is performed.
create table if not exists helmion.cora_artifact_script_revisions (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  artifact_receipt_id text not null,
  script_kind text not null check (script_kind in ('narration','training_script','orientation_script')),
  revision integer not null check (revision > 0),
  text text not null check (char_length(text) between 1 and 12000),
  source_link_receipt_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(source_link_receipt_ids) = 'array'),
  stage text not null check (stage in ('draft','source_checked','approval_requested')),
  approval_reason text check (approval_reason is null or char_length(approval_reason) between 1 and 600),
  receipt_id text not null check (char_length(receipt_id) between 8 and 256),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  created_by_subject text not null check (char_length(created_by_subject) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, artifact_receipt_id, revision), unique (tenant_id, receipt_id), unique (tenant_id, idempotency_key),
  check ((stage = 'approval_requested' and approval_reason is not null) or stage <> 'approval_requested')
);
create index if not exists cora_artifact_script_revisions_idx on helmion.cora_artifact_script_revisions(tenant_id, artifact_receipt_id, revision desc);
create or replace function helmion.reject_cora_artifact_script_mutation() returns trigger language plpgsql as $$ begin raise exception 'Artifact script revisions are append-only'; end; $$;
create trigger cora_artifact_script_append_only before update or delete on helmion.cora_artifact_script_revisions for each row execute function helmion.reject_cora_artifact_script_mutation();
alter table helmion.cora_artifact_script_revisions enable row level security;
create policy cora_artifact_script_tenant_select on helmion.cora_artifact_script_revisions for select using (tenant_id = current_setting('helmion.tenant_id', true));
create policy cora_artifact_script_tenant_insert on helmion.cora_artifact_script_revisions for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
