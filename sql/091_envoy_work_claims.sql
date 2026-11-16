-- Envoy work claims (fix programme Bite J, 2026-11-16; the no-claim
-- race of Scribe letter 727 and load-programme ceiling 5): the
-- channel dispatch path (envoy-mesh.mjs agentWork) computed each
-- poll's due set from the channel record alone — a message stayed
-- due for a seat until that seat's reply landed — and no
-- database-level claim existed on a hand-out, so two runners
-- serving one tenant (the real customer shape: a desktop and a
-- laptop) could both take the same work and both invoke the
-- provider for it. One row here is one hand-out of one message to
-- one seat, taken atomically at dispatch time in a single
-- conditional insert (envoy-mesh.mjs claimWorkItems): the row's
-- primary key is the arbitration, an unexpired row refuses every
-- later claim, and an expired row is taken over by the next
-- claim — the lease shape the profile-sync job claim
-- (sql/070, profile-sync.mjs claimNext) already proved on its own
-- road. The claim's life is bounded by expires_at: a runner that
-- dies after claiming loses nothing permanently, because the
-- message leaves the dispatch window 30 minutes after it was
-- posted and the claim expires well inside that window, so a
-- later poll re-offers the work while it can still be answered.
-- A seat's reply remains the durable answered mark, exactly as
-- before; the claim only governs the hand-out.
CREATE TABLE IF NOT EXISTS helmion.envoy_work_claims (
  tenant_id text NOT NULL REFERENCES helmion.tenants(tenant_id) ON DELETE CASCADE,
  channel_id uuid NOT NULL,
  message_id uuid NOT NULL,
  seat text NOT NULL CHECK (char_length(seat) BETWEEN 1 AND 128),
  claimed_by text NOT NULL CHECK (char_length(claimed_by) BETWEEN 1 AND 256),
  claimed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, message_id, seat),
  CONSTRAINT envoy_work_claims_message_fk
    FOREIGN KEY (tenant_id, channel_id, message_id)
    REFERENCES helmion.envoy_messages (tenant_id, channel_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS envoy_work_claims_expires_idx
  ON helmion.envoy_work_claims (expires_at);

ALTER TABLE helmion.envoy_work_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS envoy_work_claims_tenant_isolation ON helmion.envoy_work_claims;
CREATE POLICY envoy_work_claims_tenant_isolation ON helmion.envoy_work_claims
  USING (tenant_id = current_setting('helmion.tenant_id', true));
