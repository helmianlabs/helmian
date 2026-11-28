-- Runner provider presence: admit the Muse seat (Meta model API —
-- src/cloud/provider-registry.mjs id 'muse', vault slot muse:
-- MODEL_API_KEY) to the presence table's provider-name check, so the
-- box worker's presence reports for that seat can land. Same widening
-- the in-code repair in src/cloud/runner-presence.mjs performs; this
-- migration is the durable form. Exactly one name joins the twelve of
-- migration 071. Presence only: no credential ever rides this table
-- (migration 057 contract).
alter table helmion.runner_provider_presence drop constraint if exists runner_provider_presence_provider_name_check;
alter table helmion.runner_provider_presence add constraint runner_provider_presence_provider_name_check check (provider_name in ('gemini', 'claude', 'openai', 'grok', 'xai', 'mistral', 'runway', 'ollama', 'groq', 'nvidia', 'cloudflare', 'openrouter', 'muse'));
