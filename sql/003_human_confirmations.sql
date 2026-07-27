alter table helmion.maestro_operations
  drop constraint if exists maestro_operations_operation_type_check;

alter table helmion.maestro_operations
  add constraint maestro_operations_operation_type_check check (
    operation_type in (
      'ACQUIRE_LEASE',
      'CREATE_CHECKPOINT',
      'RELEASE_LEASE',
      'TRANSFER_LEASE',
      'CONSUME_CONFIRMATION'
    )
  );

create table if not exists helmion.human_identity_keys (
  id bigserial primary key,
  provider text not null
    check (provider ~ '^[a-z0-9][a-z0-9._:@/-]{0,199}$'),
  subject text not null
    check (subject ~ '^[a-z0-9][a-z0-9._:@/-]{0,199}$'),
  key_id text not null
    check (key_id ~ '^[a-z0-9][a-z0-9._:@/-]{0,199}$'),
  algorithm text not null check (algorithm = 'Ed25519'),
  public_key_pem text not null
    check (nullif(trim(public_key_pem), '') is not null),
  active boolean not null default true,
  valid_from timestamptz not null default clock_timestamp(),
  valid_until timestamptz,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint human_identity_key_validity check (
    valid_until is null or valid_until > valid_from
  ),
  constraint human_identity_key_revocation check (
    revoked_at is null or revoked_at >= valid_from
  ),
  unique (provider, key_id)
);

create table if not exists helmion.human_handoff_confirmations (
  id bigserial primary key,
  project_slug text not null
    references helmion.projects(slug) on delete cascade,
  handoff_id bigint not null
    references helmion.maestro_handoffs(id) on delete cascade,
  identity_key_id bigint not null
    references helmion.human_identity_keys(id),
  identity_provider text not null,
  identity_subject text not null,
  identity_key_id_snapshot text not null,
  nonce text not null,
  action_hash text not null check (action_hash ~ '^[0-9a-f]{64}$'),
  action jsonb not null check (jsonb_typeof(action) = 'object'),
  claims jsonb not null check (jsonb_typeof(claims) = 'object'),
  signature text not null,
  assertion_hash text not null check (assertion_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz,
  consumed_by_coordinator text,
  consumed_by_instance text,
  constraint human_confirmation_expiry check (expires_at > issued_at),
  constraint human_confirmation_consumption_state check (
    (
      consumed_at is null
      and consumed_by_coordinator is null
      and consumed_by_instance is null
    )
    or (
      consumed_at is not null
      and nullif(trim(consumed_by_coordinator), '') is not null
      and nullif(trim(consumed_by_instance), '') is not null
    )
  ),
  unique (identity_key_id, nonce)
);

create index if not exists human_handoff_confirmation_available_idx
  on helmion.human_handoff_confirmations(
    project_slug, handoff_id, action_hash, expires_at, id
  )
  where consumed_at is null;
