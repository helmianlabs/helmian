-- Emoji style preference: per-user "playful" (emoji-rich) vs "plain"
-- ("get off my lawn") presentation mode. Presentation only — this never
-- touches governance, audit, approval, or evidence surfaces, which stay sober.
-- NULL means unset and resolves to 'playful', preserving shipped behavior.
alter table helmion.workspace_layout_preferences
  add column if not exists emoji_mode text
  check (emoji_mode is null or emoji_mode in ('playful', 'plain'));

alter table helmion.workspace_layout_role_defaults
  add column if not exists emoji_mode text
  check (emoji_mode is null or emoji_mode in ('playful', 'plain'));
