-- Source-only Artifact Studio receipts. This records bounded intent metadata,
-- not prompts as secrets, generated media, provider keys, or provider calls.

create table if not exists helmion.cora_artifact_studio_intents (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  actor_subject text not null check (char_length(actor_subject) between 1 and 256),
  artifact_type text not null check (artifact_type in ('training','orientation')),
  title text not null check (char_length(title) between 1 and 240),
  department text not null check (char_length(department) between 1 and 160),
  objective text not null check (char_length(objective) between 1 and 1200),
  source_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(source_refs) = 'array'),
  stage text not null check (stage in ('draft','source_checked','approval_requested')),
  approval_reason text check (approval_reason is null or char_length(approval_reason) between 1 and 600),
  receipt_id text not null check (char_length(receipt_id) between 8 and 256),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  execution text not null default 'not_performed' check (execution = 'not_performed'),
  media_generation text not null default 'not_generated' check (media_generation = 'not_generated'),
  provider_invocation text not null default 'not_performed' check (provider_invocation = 'not_performed'),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, receipt_id),
  check ((stage = 'approval_requested' and approval_reason is not null) or stage <> 'approval_requested')
);

create index if not exists cora_artifact_studio_tenant_time_idx
  on helmion.cora_artifact_studio_intents(tenant_id, created_at desc, id desc);

create or replace function helmion.reject_cora_artifact_studio_mutation()
returns trigger language plpgsql as $$
begin raise exception 'helmion.cora_artifact_studio_intents is append-only'; end;
$$;
drop trigger if exists cora_artifact_studio_append_only on helmion.cora_artifact_studio_intents;
create trigger cora_artifact_studio_append_only before update or delete on helmion.cora_artifact_studio_intents
for each row execute function helmion.reject_cora_artifact_studio_mutation();

alter table helmion.cora_artifact_studio_intents enable row level security;
drop policy if exists cora_artifact_studio_tenant_select on helmion.cora_artifact_studio_intents;
create policy cora_artifact_studio_tenant_select on helmion.cora_artifact_studio_intents
  for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_artifact_studio_tenant_insert on helmion.cora_artifact_studio_intents;
create policy cora_artifact_studio_tenant_insert on helmion.cora_artifact_studio_intents
  for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
