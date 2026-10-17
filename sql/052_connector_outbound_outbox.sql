-- Connector outbound outbox: durable queue for Discord/Slack delivery.
-- The desktop reads from Discord/Slack but never sends; outbound delivery is a
-- NEW cloud capability, not desktop parity. Messages are enqueued by server
-- code (approval decisions, critical Guard findings, worker run completions,
-- the /admin test button) and drained by the connector-outbound worker, which
-- POSTs to the configured webhook URLs via postConnectorMessage
-- (src/cloud/communication-connectors.mjs: host-allowlisted, 10s timeout).
-- Webhook URLs live only in server env (HELMION_DISCORD_WEBHOOK_URL /
-- HELMION_SLACK_WEBHOOK_URL) and are never stored here: channel_label is a
-- human label like "approvals" or "guard", never a secret or URL.
-- Delivery is at-most-once per row: the worker claims with
-- SELECT ... FOR UPDATE SKIP LOCKED and transitions status one-way
-- queued -> sent or queued -> failed. Attempts are capped at 3; a message for
-- a provider with no webhook configured fails immediately with reason
-- webhook_not_configured and is never retried.
create table if not exists helmion.connector_outbound_messages (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  provider text not null check (provider in ('discord', 'slack')),
  channel_label text check (channel_label is null or char_length(channel_label) between 1 and 128),
  text text not null check (char_length(text) between 1 and 4000),
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  attempts int not null default 0 check (attempts >= 0),
  receipt jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index if not exists connector_outbound_messages_drain_idx
  on helmion.connector_outbound_messages(tenant_id, status, created_at);
