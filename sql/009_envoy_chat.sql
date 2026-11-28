-- Envoy internal chat foundation. Additive and intentionally not applied by
-- production startup; deployment must use the authenticated migration runner.
CREATE TABLE IF NOT EXISTS helmion.envoy_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES helmion.tenants(tenant_id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  kind text NOT NULL DEFAULT 'team' CHECK (kind IN ('team','direct','agent')),
  created_by_subject text NOT NULL CHECK (char_length(created_by_subject) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS helmion.envoy_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES helmion.tenants(tenant_id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES helmion.envoy_channels(id) ON DELETE CASCADE,
  author_subject text NOT NULL CHECK (char_length(author_subject) BETWEEN 1 AND 256),
  author_kind text NOT NULL CHECK (author_kind IN ('human','agent','system')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT envoy_messages_channel_tenant_fk FOREIGN KEY (tenant_id, channel_id)
    REFERENCES helmion.envoy_channels (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT envoy_messages_idempotency_key_uk UNIQUE (tenant_id, channel_id, author_subject, idempotency_key)
);

CREATE INDEX IF NOT EXISTS envoy_messages_channel_created_idx
  ON helmion.envoy_messages (tenant_id, channel_id, created_at DESC);

ALTER TABLE helmion.envoy_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE helmion.envoy_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS envoy_channels_tenant_isolation ON helmion.envoy_channels;
CREATE POLICY envoy_channels_tenant_isolation ON helmion.envoy_channels
  USING (tenant_id = current_setting('helmion.tenant_id', true));
DROP POLICY IF EXISTS envoy_messages_tenant_isolation ON helmion.envoy_messages;
CREATE POLICY envoy_messages_tenant_isolation ON helmion.envoy_messages
  USING (tenant_id = current_setting('helmion.tenant_id', true));
