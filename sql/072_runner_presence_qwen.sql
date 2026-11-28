-- Runner provider presence: admit the Qwen seat under her own name
-- ('qwen' — the seat name in src/cloud/envoy-agents.mjs), so the box
-- worker's presence reports for that seat can land under 'qwen' and a
-- reply she posts can stamp her own presence row. Until now the check
-- admitted only her engine's name ('ollama'), so the worker translated
-- her to the engine to report at all, and markAnswered rejected the
-- seat name outright — her answers could never stamp her row (the
-- qwen-rename plan, pick A: presence-only rename; the engine key stays
-- 'ollama' in the machinery places — the vault key slot, the custom
-- agent engine list, the door). Same widening the in-code repair in
-- src/cloud/runner-presence.mjs performs; this migration is the
-- durable form. Exactly one name joins the thirteen of migration 073.
-- Numbered 072 because the slot was reserved for this fix before 073
-- landed, so the list below is the full fourteen-name end state: a
-- database that already applied 073 and one applying both in number
-- order land in the same place, and the in-code repair holds the same
-- fourteen either way. Presence only: no credential ever rides this
-- table (migration 057 contract).
alter table helmion.runner_provider_presence drop constraint if exists runner_provider_presence_provider_name_check;
alter table helmion.runner_provider_presence add constraint runner_provider_presence_provider_name_check check (provider_name in ('gemini', 'claude', 'openai', 'grok', 'xai', 'mistral', 'runway', 'ollama', 'groq', 'nvidia', 'cloudflare', 'openrouter', 'muse', 'qwen'));
