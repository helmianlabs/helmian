-- Cora Organization configuration and approved knowledge metadata foundation.
-- Additive only. This migration is not executed by application startup.

create table if not exists helmion.cora_configs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  config_version integer not null check (config_version > 0),
  lifecycle text not null check (lifecycle in ('draft','testing','approved','published','rolled_back')),
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  reason text not null check (char_length(reason) between 1 and 2000),
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  created_by_subject text not null check (char_length(created_by_subject) between 1 and 256),
  created_by_role text not null check (created_by_role in ('owner','admin')),
  approved_by_subject text,
  approved_at timestamptz,
  published_by_subject text,
  published_at timestamptz,
  rollback_by_subject text,
  rollback_at timestamptz,
  rollback_reason text,
  is_current boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint cora_configs_approval_pair check ((approved_by_subject is null) = (approved_at is null)),
  constraint cora_configs_publish_pair check ((published_by_subject is null) = (published_at is null)),
  constraint cora_configs_rollback_pair check ((rollback_by_subject is null) = (rollback_at is null)),
  constraint cora_configs_current_lifecycle check (is_current = false or lifecycle = 'published')
);

create unique index if not exists cora_configs_current_published_uq
  on helmion.cora_configs (tenant_id) where lifecycle = 'published' and is_current;
create unique index if not exists cora_configs_tenant_version_uq
  on helmion.cora_configs (tenant_id, config_version);

create table if not exists helmion.cora_knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  source_key text not null check (char_length(source_key) between 1 and 128),
  title text not null check (char_length(title) between 1 and 240),
  publisher text not null check (char_length(publisher) between 1 and 240),
  canonical_uri text not null check (char_length(canonical_uri) between 1 and 1000),
  provenance text not null check (char_length(provenance) between 1 and 1000),
  lifecycle text not null check (lifecycle in ('draft','approved','retired')),
  reviewed_by_subject text,
  reviewed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, source_key),
  unique (tenant_id, id)
);

create table if not exists helmion.cora_knowledge_packs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  source_id uuid not null references helmion.cora_knowledge_sources(id) on delete restrict,
  pack_key text not null check (char_length(pack_key) between 1 and 128),
  version text not null check (char_length(version) between 1 and 64),
  lifecycle text not null check (lifecycle in ('draft','approved','retired')),
  allowlisted boolean not null default false,
  provenance text not null check (char_length(provenance) between 1 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, pack_key, version),
  unique (tenant_id, id),
  constraint cora_packs_allowlist_lifecycle check (allowlisted = false or lifecycle = 'approved'),
  constraint cora_packs_source_tenant_fk foreign key (tenant_id, source_id)
    references helmion.cora_knowledge_sources(tenant_id, id) on delete restrict
);

create table if not exists helmion.cora_knowledge_snippets (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  pack_id uuid not null,
  citation text not null check (char_length(citation) between 1 and 1000),
  text_reference text not null check (char_length(text_reference) between 1 and 2000),
  content_sha256 text,
  created_at timestamptz not null default clock_timestamp(),
  constraint cora_snippets_pack_tenant_fk foreign key (tenant_id, pack_id)
    references helmion.cora_knowledge_packs(tenant_id, id) on delete cascade
);

create index if not exists cora_knowledge_sources_tenant_idx on helmion.cora_knowledge_sources(tenant_id, lifecycle);
create index if not exists cora_knowledge_packs_tenant_idx on helmion.cora_knowledge_packs(tenant_id, lifecycle, allowlisted);
create index if not exists cora_knowledge_snippets_pack_idx on helmion.cora_knowledge_snippets(tenant_id, pack_id, id);

alter table helmion.cora_configs enable row level security;
alter table helmion.cora_knowledge_sources enable row level security;
alter table helmion.cora_knowledge_packs enable row level security;
alter table helmion.cora_knowledge_snippets enable row level security;

drop policy if exists cora_configs_tenant_isolation on helmion.cora_configs;
create policy cora_configs_tenant_isolation on helmion.cora_configs
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_knowledge_sources_tenant_isolation on helmion.cora_knowledge_sources;
create policy cora_knowledge_sources_tenant_isolation on helmion.cora_knowledge_sources
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_knowledge_packs_tenant_isolation on helmion.cora_knowledge_packs;
create policy cora_knowledge_packs_tenant_isolation on helmion.cora_knowledge_packs
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists cora_knowledge_snippets_tenant_isolation on helmion.cora_knowledge_snippets;
create policy cora_knowledge_snippets_tenant_isolation on helmion.cora_knowledge_snippets
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
