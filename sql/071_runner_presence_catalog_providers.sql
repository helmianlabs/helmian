-- Runner provider presence: admit the provider-catalog seats
-- (src/cloud/provider-registry.mjs — groq, nvidia, cloudflare,
-- openrouter) to the presence table's provider-name check, so the box
-- worker's presence reports for those seats can land. Same widening
-- the in-code repair in src/cloud/runner-presence.mjs performs; this
-- migration is the durable form. Presence only: no credential ever
-- rides this table (migration 057 contract).
alter table helmion.runner_provider_presence drop constraint if exists runner_provider_presence_provider_name_check;
alter table helmion.runner_provider_presence add constraint runner_provider_presence_provider_name_check check (provider_name in ('gemini', 'claude', 'openai', 'grok', 'xai', 'mistral', 'runway', 'ollama', 'groq', 'nvidia', 'cloudflare', 'openrouter'));
