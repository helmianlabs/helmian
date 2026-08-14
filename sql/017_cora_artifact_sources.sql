-- Organization-scoped source metadata and immutable Artifact Studio linkage receipts.
-- No source content, secrets, URL/file fetch, provider call, or generated media is stored.

create table if not exists helmion.cora_artifact_sources (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  source_key text not null check (source_key ~ '^[a-z][a-z0-9._:-]{0,95}$'),
  title text not null check (char_length(title) between 1 and 240),
  publisher text not null check (char_length(publisher) between 1 and 240),
  classification text not null check (classification in ('internal_manual','sop','regulatory','training_reference','other')),
  provenance text not null check (char_length(provenance) between 1 and 800),
  reference text not null check (char_length(reference) between 1 and 800),
  effective_at timestamptz,
  expires_at timestamptz,
  lifecycle text not null default 'draft' check (lifecycle in ('draft','review_requested','approved','rejected')),
  created_by_subject text not null check (char_length(created_by_subject) between 1 and 256),
  reviewed_by_subject text,
  reviewed_at timestamptz,
  review_reason text check (review_reason is null or char_length(review_reason) between 1 and 600),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, source_key), unique (tenant_id, idempotency_key),
  check (expires_at is null or effective_at is null or expires_at > effective_at)
);

create table if not exists helmion.cora_artifact_source_links (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  artifact_receipt_id text not null,
  source_id bigint not null references helmion.cora_artifact_sources(id),
  source_key text not null, source_title text not null,
  source_lifecycle text not null, source_classification text not null,
  source_provenance text not null, source_effective_at timestamptz, source_expires_at timestamptz,
  link_reason text not null check (char_length(link_reason) between 1 and 600),
  link_receipt_id text not null check (char_length(link_receipt_id) between 8 and 256),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  created_by_subject text not null check (char_length(created_by_subject) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, link_receipt_id), unique (tenant_id, idempotency_key)
);

create index if not exists cora_artifact_sources_tenant_idx on helmion.cora_artifact_sources(tenant_id, source_key);
create index if not exists cora_artifact_source_links_tenant_idx on helmion.cora_artifact_source_links(tenant_id, artifact_receipt_id, created_at desc);
-- Source lifecycle metadata is transitionable only through the authenticated admin
-- repository; linkage receipts below remain immutable append-only evidence.
create or replace function helmion.reject_cora_artifact_source_link_mutation() returns trigger language plpgsql as $$ begin raise exception 'Artifact source link receipts are append-only'; end; $$;
drop trigger if exists cora_artifact_source_links_append_only on helmion.cora_artifact_source_links;
create trigger cora_artifact_source_links_append_only before update or delete on helmion.cora_artifact_source_links for each row execute function helmion.reject_cora_artifact_source_link_mutation();
alter table helmion.cora_artifact_sources enable row level security;
alter table helmion.cora_artifact_source_links enable row level security;
create policy cora_artifact_sources_tenant_select on helmion.cora_artifact_sources for select using (tenant_id = current_setting('helmion.tenant_id', true));
create policy cora_artifact_sources_tenant_insert on helmion.cora_artifact_sources for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
create policy cora_artifact_sources_tenant_update on helmion.cora_artifact_sources for update using (tenant_id = current_setting('helmion.tenant_id', true)) with check (tenant_id = current_setting('helmion.tenant_id', true));
create policy cora_artifact_source_links_tenant_select on helmion.cora_artifact_source_links for select using (tenant_id = current_setting('helmion.tenant_id', true));
create policy cora_artifact_source_links_tenant_insert on helmion.cora_artifact_source_links for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
