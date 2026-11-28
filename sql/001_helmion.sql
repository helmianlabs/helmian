create schema if not exists helmion;

create table if not exists helmion.projects (
  slug text primary key,
  name text not null,
  root_path text,
  created_at timestamptz not null default now()
);

create table if not exists helmion.context_entries (
  id bigserial primary key,
  project_slug text references helmion.projects(slug) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  unique (project_slug, key)
);

create table if not exists helmion.blockers (
  id bigserial primary key,
  project_slug text references helmion.projects(slug) on delete cascade,
  status text not null default 'OPEN'
    check (status in ('OPEN','ACTIVE','BLOCKED','RESOLVED','WONT_FIX')),
  severity text not null default 'medium'
    check (severity in ('low','medium','high','critical')),
  description text not null,
  file_path text,
  module_name text,
  error_signature text,
  outcome text,
  citation text,
  root_cause text,
  snippet text,
  lesson text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint resolved_blocker_requires_proof check (
    status <> 'RESOLVED' or (
      nullif(trim(outcome), '') is not null
      and nullif(trim(citation), '') is not null
      and citation ~ '^.+:[0-9]+(:[0-9]+)?$'
      and nullif(trim(root_cause), '') is not null
      and nullif(trim(snippet), '') is not null
      and resolved_at is not null
    )
  )
);

create index if not exists blockers_active_project_idx
  on helmion.blockers(project_slug, status, severity)
  where status in ('OPEN','ACTIVE','BLOCKED');

create table if not exists helmion.autonomy_rules (
  id bigserial primary key,
  project_slug text references helmion.projects(slug) on delete cascade,
  pattern text not null,
  flags text not null default 'i',
  severity text not null default 'flag' check (severity in ('flag','block')),
  reason text not null,
  snippet text not null,
  citation text not null,
  from_blocker bigint references helmion.blockers(id),
  active boolean not null default true,
  promotion_basis text,
  created_at timestamptz not null default now(),
  unique (project_slug, pattern)
);

create table if not exists helmion.governance_actions (
  action_hash text primary key,
  project_slug text references helmion.projects(slug) on delete cascade,
  tier text not null check (tier in ('A','B')),
  operation jsonb not null,
  diff_summary text,
  state text not null default 'PENDING'
    check (state in ('PENDING','APPROVED','REJECTED','EXECUTED')),
  created_at timestamptz not null default now(),
  executed_at timestamptz
);

create table if not exists helmion.advisory_reviews (
  id bigserial primary key,
  action_hash text not null references helmion.governance_actions(action_hash) on delete cascade,
  advisor text not null check (advisor in ('claude','gemini','grok','openai')),
  decision text not null check (decision in ('APPROVED','REJECTED')),
  read_only boolean not null default true,
  rationale text,
  evidence jsonb not null default '{}'::jsonb,
  reviewed_at timestamptz not null default now(),
  unique (action_hash, advisor)
);

create table if not exists helmion.as2_outbound (
  id bigserial primary key,
  project_slug text references helmion.projects(slug) on delete cascade,
  message_type text not null check (message_type in ('997','990')),
  message_id text not null unique,
  station text not null,
  payload text not null,
  status text not null default 'PENDING_RETRY'
    check (status in ('PENDING_RETRY','FAILED','SENT')),
  http_status integer,
  mdn jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint sent_requires_transport_proof check (
    status <> 'SENT' or (http_status = 200 and mdn is not null and sent_at is not null)
  )
);

create index if not exists as2_unacknowledged_idx
  on helmion.as2_outbound(created_at)
  where status in ('PENDING_RETRY','FAILED');

create or replace view helmion.stale_as2_blockers as
select id, project_slug, message_type, message_id, station, status, created_at
from helmion.as2_outbound
where status in ('PENDING_RETRY','FAILED')
  and created_at < now() - interval '15 minutes';
