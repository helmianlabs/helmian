-- 069: Built-in seat faces (emoji bite 5, 2026-11-04) — identity.
-- A workspace's five provider seats (Claude, ChatGPT, Grok, Gemini,
-- Mistral) each carry ONE character face for the whole tenant, the way
-- a custom agent's face rides its record (Qwen's crab): the owner or an
-- admin sets it in the Agents panel, and every member sees the same
-- face on the seat's messages, panel card and activity rows. One row
-- per (tenant, provider); no row means the seat wears its shipped
-- default (envoy-faces.mjs's AGENT_FACE_DEFAULTS, in the emoji map).
--
-- The emoji column stores the Unicode CHARACTER, never the asset slug:
-- that is the vocabulary every other face in the system already uses
-- (custom agents' emoji field, user_profiles.avatar_emoji, the 055
-- per-viewer icons). Unicode stays the data; the desk renders the
-- character through bite 1's map to Helmian's own art, with the
-- platform glyph as the never-broken fallback. No SQL check on which
-- emoji for the same reason sql/067/068 carry none on provider/slug:
-- the set grows by shipping assets, not by migration, so the store
-- validates against the map.
--
-- Deliberately NOT the 055 table: workspace_agent_icons is a
-- per-VIEWER override (each member privately re-skins the seats in
-- their own /app shell). A seat's identity face is the opposite shape —
-- workspace-shared — so it gets its own table rather than bending the
-- per-user one.
create table if not exists helmion.workspace_agent_faces (
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  provider text not null check (provider in ('claude', 'openai', 'grok', 'gemini', 'mistral')),
  emoji text not null check (char_length(emoji) between 1 and 16),
  updated_by_subject text not null check (char_length(updated_by_subject) between 1 and 256),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, provider)
);

alter table helmion.workspace_agent_faces enable row level security;
drop policy if exists workspace_agent_faces_tenant_isolation on helmion.workspace_agent_faces;
create policy workspace_agent_faces_tenant_isolation on helmion.workspace_agent_faces
  using (tenant_id = current_setting('helmion.tenant_id', true))
  with check (tenant_id = current_setting('helmion.tenant_id', true));
