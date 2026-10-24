-- 060: Composer "+" attachments on Envoy messages.
-- One nullable jsonb column carries the picker's structured metadata
-- ({ attachments: [{kind:'skill'|'connector'|'plugin', ...}], webSearch?: bool }),
-- normalized by normalizeMessageMetadata (src/cloud/envoy-agents.mjs).
-- Nullable with no default: every pre-existing row and every client that
-- sends the original {channelId, body, idempotencyKey} shape is unaffected.

alter table helmion.envoy_messages
  add column if not exists metadata jsonb;
