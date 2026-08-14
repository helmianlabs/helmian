-- Source-only Artifact Studio execution request/approval receipts.
-- No provider call, media generation, credential, prompt secret, billing, or external write.
create table if not exists helmion.cora_artifact_execution_requests (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  artifact_receipt_id text not null,
  script_receipt_id text not null,
  source_link_receipt_ids jsonb not null check (jsonb_typeof(source_link_receipt_ids) = 'array'),
  catalog_entry_id text not null check (char_length(catalog_entry_id) between 1 and 128),
  provider text not null check (char_length(provider) between 1 and 64),
  model text not null check (char_length(model) between 1 and 128),
  modality text not null check (modality in ('text','audio','image','video','multimodal')),
  estimated_requested_tokens bigint check (estimated_requested_tokens is null or estimated_requested_tokens >= 0),
  estimated_audio_seconds numeric(18,6) check (estimated_audio_seconds is null or estimated_audio_seconds >= 0),
  estimated_image_units numeric(18,6) check (estimated_image_units is null or estimated_image_units >= 0),
  estimated_video_units numeric(18,6) check (estimated_video_units is null or estimated_video_units >= 0),
  estimated_cost_minor numeric(18,6) check (estimated_cost_minor is null or estimated_cost_minor >= 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  external_execution boolean not null default true check (external_execution = true),
  policy_decision text not null check (policy_decision in ('step-up','allow','deny')),
  budget_state text not null check (char_length(budget_state) between 1 and 64),
  status text not null check (status in ('approval_required','blocked','queued')),
  approval_ref text,
  actor_subject text not null check (char_length(actor_subject) between 1 and 256),
  actor_role text not null check (actor_role in ('owner','admin','member','auditor')),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  supersedes_receipt_id text,
  receipt_id text not null check (char_length(receipt_id) between 8 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, idempotency_key), unique (tenant_id, receipt_id),
  check ((status = 'approval_required' and approval_ref is null) or (status in ('blocked','queued'))),
  check ((status = 'queued' and approval_ref is not null) or status <> 'queued')
);
create index if not exists cora_artifact_execution_tenant_time_idx on helmion.cora_artifact_execution_requests(tenant_id, artifact_receipt_id, created_at desc, id desc);
create or replace function helmion.reject_cora_artifact_execution_mutation() returns trigger language plpgsql as $$ begin raise exception 'helmion.cora_artifact_execution_requests is append-only'; end; $$;
drop trigger if exists cora_artifact_execution_append_only on helmion.cora_artifact_execution_requests;
create trigger cora_artifact_execution_append_only before update or delete on helmion.cora_artifact_execution_requests for each row execute function helmion.reject_cora_artifact_execution_mutation();
alter table helmion.cora_artifact_execution_requests enable row level security;
drop policy if exists cora_artifact_execution_tenant_select on helmion.cora_artifact_execution_requests;
create policy cora_artifact_execution_tenant_select on helmion.cora_artifact_execution_requests for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_artifact_execution_tenant_insert on helmion.cora_artifact_execution_requests;
create policy cora_artifact_execution_tenant_insert on helmion.cora_artifact_execution_requests for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
