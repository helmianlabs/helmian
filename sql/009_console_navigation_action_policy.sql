-- Add a platform-global kill switch for the fixed, non-executing navigation-intent hand.
alter table helmion.platform_action_policy
  add column if not exists console_navigation_intent_enabled boolean not null default true;
