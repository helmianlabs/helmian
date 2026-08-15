-- Review/apply only through the approved Helmian database migration procedure.
CREATE SCHEMA IF NOT EXISTS helmion;
CREATE TABLE IF NOT EXISTS helmion.billing_events (
  event_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS helmion.billing_entitlements (
  customer_id text NOT NULL,
  product_key text NOT NULL,
  session_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_key)
);
