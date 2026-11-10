-- Helm's setup knowledge base: the unsorted miss queue
-- (Troy's order, 2026-11-09; wiring bite V2).
--
-- The setup guide (src/cloud/helm-kb.mjs + helm-kb.json) answers
-- a new user's setup questions in the channel as Maestro, word
-- for word from its entries. A question the guide cannot answer,
-- asked on a desk with no AI connected to answer it either, is
-- filed HERE: the question's words only, who asked, and where.
-- This is the librarian's unsorted idea applied to questions —
-- Scribe's UNSORTED is where an item lands when no filing rule
-- takes it, "kept loud on purpose: an unsorted item is a filing
-- rule waiting to be learned." Real unanswered questions are how
-- the guide grows: a person reads this queue, writes the entry
-- the question needed, and the entry ships with the guide's data.
--
-- It is deliberately NOT the librarian's incident store
-- (sql/076): incidents are a tenant's mistakes and solutions and
-- ride work items as recall context — a new user's raw questions
-- do not belong in a seat's prompt. And it is not tenant content:
-- nothing here is read back into any workspace surface. The
-- tenant_id rides along because the filing happens inside the
-- sender's tenant transaction (and so one workspace's questions
-- can be told from another's when the queue is reviewed), with
-- the same 075-pattern RLS discipline as its neighbours.
--
-- One row per (tenant, person, question): asking the same
-- question again counts up seen_count and moves last_seen_at —
-- the queue ranks itself by what new users actually keep asking.
--
-- Numbering: 084 is the next free number after 083 on main at
-- build time (2026-11-09). Independently idempotent (create if
-- not exists / drop policy if exists), like its neighbours.
-- NOT applied by the build — the parent applies it on the box
-- road. The filing code is fail-soft until it lands: a missing
-- table files nothing and changes nothing.
create table if not exists helmion.helm_kb_misses (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  channel_id text not null check (char_length(channel_id) between 1 and 64),
  person_subject text not null check (char_length(person_subject) between 1 and 256),
  question text not null check (char_length(question) between 1 and 2000),
  question_key text not null check (char_length(question_key) between 1 and 300),
  seen_count integer not null default 1 check (seen_count >= 1),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (tenant_id, person_subject, question_key)
);
create index if not exists helm_kb_misses_recent_idx on helmion.helm_kb_misses(last_seen_at desc);
alter table helmion.helm_kb_misses enable row level security;
drop policy if exists helm_kb_misses_tenant_select on helmion.helm_kb_misses;
create policy helm_kb_misses_tenant_select on helmion.helm_kb_misses for select using (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists helm_kb_misses_tenant_insert on helmion.helm_kb_misses;
create policy helm_kb_misses_tenant_insert on helmion.helm_kb_misses for insert with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists helm_kb_misses_tenant_update on helmion.helm_kb_misses;
create policy helm_kb_misses_tenant_update on helmion.helm_kb_misses for update using (tenant_id = current_setting('helmion.tenant_id', true)) with check (tenant_id = current_setting('helmion.tenant_id', true));
drop policy if exists helm_kb_misses_tenant_delete on helmion.helm_kb_misses;
create policy helm_kb_misses_tenant_delete on helmion.helm_kb_misses for delete using (tenant_id = current_setting('helmion.tenant_id', true));
