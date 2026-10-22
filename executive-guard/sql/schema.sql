-- Executive Guard audit + approvals schema for a hosted (Postgres) deployment.
-- NOT APPLIED ANYWHERE. Deliberately kept outside the repo's numbered sql/
-- migrations (and away from the retired 035-040 numbers) until Troy decides
-- where Executive Guard is hosted and approves a migration.

create table if not exists executive_guard_audit (
  seq          bigint primary key,
  at           timestamptz not null,
  prev_hash    char(64) not null,
  hash         char(64) not null unique,
  event        text not null,
  device_id    text,
  approver_id  text,
  decision_id  uuid,
  approval_id  uuid,
  verdict      text check (verdict in ('allow','deny','ask')),
  rule_id      text,
  action_hash  char(64),
  body         jsonb not null
);

-- Append-only: no updates or deletes from the application role.
create or replace function executive_guard_audit_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'executive_guard_audit is append-only';
end $$;

drop trigger if exists executive_guard_audit_no_update on executive_guard_audit;
create trigger executive_guard_audit_no_update before update or delete on executive_guard_audit
  for each row execute function executive_guard_audit_append_only();

create table if not exists executive_guard_approvals (
  id           uuid primary key,
  status       text not null check (status in ('pending','approved','denied','expired')),
  device_id    text not null,
  action_hash  char(64) not null,
  action       jsonb not null,
  rule_id      text not null,
  created_at   timestamptz not null,
  expires_at   timestamptz not null,
  decided_by   text,
  decided_at   timestamptz
);
create index if not exists executive_guard_approvals_pending on executive_guard_approvals (status) where status = 'pending';
