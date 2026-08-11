begin;

alter table helmion.platform_action_policy
  add column if not exists equipment_safety_status_enabled boolean not null default true,
  add column if not exists equipment_safety_check_enabled boolean not null default true,
  add column if not exists equipment_safety_escalation_enabled boolean not null default true;

commit;
