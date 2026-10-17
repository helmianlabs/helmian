-- Guard findings and acknowledgements: durable per-tenant record of governance
-- findings raised by the browser extension, the governance kernel, or the cloud,
-- plus human acknowledgements. Findings are deduped by fingerprint; a re-sighting
-- increments sighting_count and clears any ack (an ack never hides a finding that
-- fires again). Acks never suppress criticals in the UI — that is a display rule,
-- not a schema rule. Nothing here invokes a provider, model, or filesystem.
create table if not exists helmion.guard_findings (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  fingerprint text not null check (char_length(fingerprint) between 8 and 256),
  source text not null check (source in ('browser-extension', 'governance-kernel', 'cloud')),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  title text not null check (char_length(title) between 1 and 280),
  detail jsonb not null default '{}'::jsonb,
  page_ref text check (page_ref is null or char_length(page_ref) between 1 and 2048),
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  sighting_count integer not null default 1 check (sighting_count >= 1),
  unique (tenant_id, fingerprint)
);

create table if not exists helmion.guard_finding_acks (
  id bigserial primary key,
  tenant_id text not null references helmion.tenants(tenant_id) on delete cascade,
  finding_fingerprint text not null check (char_length(finding_fingerprint) between 8 and 256),
  acked_by_subject text not null check (char_length(acked_by_subject) between 1 and 256),
  acked_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, finding_fingerprint)
);

create index if not exists guard_findings_tenant_time_idx
  on helmion.guard_findings(tenant_id, last_seen_at desc, id desc);
