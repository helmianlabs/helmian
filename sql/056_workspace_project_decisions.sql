-- Workspace project decision log: append-only record of decisions per
-- (tenant, project), the cloud counterpart of the desktop Canvas tab's
-- "Record a decision" flow. Canvas notes stay a single upserted row
-- (migration 053); decisions are an append-only log so history is never
-- overwritten by a later save. Rows are immutable: a BEFORE UPDATE OR
-- DELETE trigger rejects any mutation, using the same plpgsql pattern as
-- migration 013 (cora_agent_task append-only tables).
--
-- The composite foreign key to workspace_projects(tenant_id, project_key)
-- guarantees a decision can never attach to a project that does not exist
-- (same lesson as the 048/049/050 FK fix: workspace_projects has a
-- composite primary key, so a FK on project_key alone is rejected).
create table if not exists helmion.workspace_project_decisions (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  project_key text not null,
  decision_text text not null check (char_length(decision_text) between 1 and 32768),
  recorded_by_subject text,
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (tenant_id, project_key) references helmion.workspace_projects(tenant_id, project_key) on delete cascade
);

create index if not exists workspace_project_decisions_tenant_project_time_idx
  on helmion.workspace_project_decisions(tenant_id, project_key, recorded_at, id);

create or replace function helmion.reject_workspace_decision_mutation()
returns trigger language plpgsql as $$
begin raise exception 'helmion.workspace_project_decisions is append-only'; end;
$$;
drop trigger if exists workspace_decision_append_only on helmion.workspace_project_decisions;
create trigger workspace_decision_append_only before update or delete on helmion.workspace_project_decisions
for each row execute function helmion.reject_workspace_decision_mutation();

-- Backfill: adopt the single decision_text each existing canvas row holds
-- as that project's first log entry, keeping the canvas row's update time.
-- decision_text stays on the canvas row in this migration (rollout safety:
-- the code keeps reading it until every database has this table); a later
-- migration may drop the column once the log is the only writer.
insert into helmion.workspace_project_decisions (tenant_id, project_key, decision_text, recorded_at)
select tenant_id, project_key, decision_text, updated_at
from helmion.workspace_project_canvases
where decision_text <> '';
