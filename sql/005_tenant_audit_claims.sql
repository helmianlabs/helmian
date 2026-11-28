-- Short-lived, tenant-scoped outbox claims. This is separate from migration
-- 004 so the completed tenant audit foundation keeps its checksum.

alter table helmion.audit_outbox
  add column if not exists claim_token uuid,
  add column if not exists claim_expires_at timestamptz;

alter table helmion.audit_outbox
  drop constraint if exists audit_outbox_claim_state;

alter table helmion.audit_outbox
  add constraint audit_outbox_claim_state check (
    (claim_token is null and claim_expires_at is null)
    or (claim_token is not null and claim_expires_at is not null)
  );

create unique index if not exists audit_outbox_active_claim_idx
  on helmion.audit_outbox(claim_token)
  where claim_token is not null and delivered_at is null;

create index if not exists audit_outbox_claimable_idx
  on helmion.audit_outbox(tenant_id, available_at, event_id)
  where delivered_at is null;
