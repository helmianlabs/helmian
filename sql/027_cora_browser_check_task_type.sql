-- Additive browser-check preparation class. This permits a durable intent only;
-- it does not grant browser control or execute a browser, provider, or filesystem action.

alter table helmion.cora_agent_task_intents
  drop constraint if exists cora_agent_task_intents_task_type_check;

alter table helmion.cora_agent_task_intents
  add constraint cora_agent_task_intents_task_type_check
  check (task_type in ('workspace_preview', 'browser_check'));
