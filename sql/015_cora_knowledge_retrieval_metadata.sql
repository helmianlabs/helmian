-- Additive metadata for source-only Cora knowledge retrieval.
-- Nullable fields preserve existing metadata rows without fabricating content.

alter table helmion.cora_knowledge_sources
  add column if not exists expires_at timestamptz;
alter table helmion.cora_knowledge_packs
  add column if not exists expires_at timestamptz;
alter table helmion.cora_knowledge_snippets
  add column if not exists excerpt text;
alter table helmion.cora_knowledge_snippets
  add column if not exists expires_at timestamptz;

alter table helmion.cora_knowledge_snippets
  drop constraint if exists cora_snippets_excerpt_bounds;
alter table helmion.cora_knowledge_snippets
  add constraint cora_snippets_excerpt_bounds check (excerpt is null or char_length(excerpt) between 1 and 2000);

create index if not exists cora_knowledge_retrieval_effective_idx
  on helmion.cora_knowledge_snippets(tenant_id, expires_at, id)
  where excerpt is not null;
