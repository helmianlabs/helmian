-- Envoy internal chat foundation. Additive and intentionally not applied by
-- production startup; deployment must use the authenticated migration runner.
CREATE TABLE IF NOT EXISTS envoy_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  kind text NOT NULL DEFAULT 'team' CHECK (kind IN ('team','direct','agent')),
  created_by_subject text NOT NULL CHECK (char_length(created_by_subject) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS envoy_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES envoy_channels(id) ON DELETE CASCADE,
  author_subject text NOT NULL CHECK (char_length(author_subject) BETWEEN 1 AND 256),
  author_kind text NOT NULL CHECK (author_kind IN ('human','agent','system')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT envoy_messages_channel_tenant_fk FOREIGN KEY (tenant_id, channel_id)
    REFERENCES envoy_channels (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS envoy_messages_channel_created_idx
  ON envoy_messages (tenant_id, channel_id, created_at DESC);

ALTER TABLE envoy_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE envoy_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS envoy_channels_tenant_isolation ON envoy_channels;
CREATE POLICY envoy_channels_tenant_isolation ON envoy_channels
  USING (tenant_id = current_setting('helmion.tenant_id', true));
DROP POLICY IF EXISTS envoy_messages_tenant_isolation ON envoy_messages;
CREATE POLICY envoy_messages_tenant_isolation ON envoy_messages
  USING (tenant_id = current_setting('helmion.tenant_id', true));
