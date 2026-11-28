-- Additive metadata for authenticated Cora knowledge curation.
-- Source-only foundation; never executed by application startup in this slice.

alter table helmion.cora_knowledge_sources
  add column if not exists effective_at timestamptz;
alter table helmion.cora_knowledge_packs
  add column if not exists effective_at timestamptz;
alter table helmion.cora_knowledge_packs
  add column if not exists reviewed_by_subject text;
alter table helmion.cora_knowledge_packs
  add column if not exists reviewed_at timestamptz;

create index if not exists cora_knowledge_sources_effective_idx
  on helmion.cora_knowledge_sources(tenant_id, lifecycle, effective_at, expires_at);
create index if not exists cora_knowledge_packs_effective_idx
  on helmion.cora_knowledge_packs(tenant_id, lifecycle, allowlisted, effective_at, expires_at);
