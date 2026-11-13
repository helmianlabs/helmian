-- Watch ticket signing secret (live agent-browser view, Bite 2.5,
-- 2026-11-12).
--
-- The Browser tab's watch tickets (src/cloud/watch-tickets.mjs) are
-- signed statements: base64url JSON plus an HMAC-SHA256 signature.
-- Bite 2 keyed that signature with a secret held in two hand-placed
-- copies (a Vercel environment variable on the cloud side and an env
-- file on the box), and the Vercel copy could never be placed from
-- the tooling here, so the deployed mint route answered 503 by
-- design. This table retires the hand placement: the signer holds
-- its secret HERE, in the app's own database. On first need the
-- signer generates a strong random secret and stores it as the
-- single row of this table; a rotation is one update of that row.
-- The watch service on the box holds no copy at all: it fetches the
-- current value from the cloud over its device-token road
-- (GET /api/admin/envoy/watch-secret) and keeps it in memory only,
-- refetching when a verification fails, so a rotation here heals
-- the box side on its own.
--
-- Deliberately NOT tenant data: the secret is app-global (one
-- signer for the whole deployment), so there is no tenant_id column
-- and no tenant policy. Row level security is enabled with no
-- policies at all, which denies every role except the table's owner
-- (the role the cloud runtime and the migration runner share); the
-- value is never read back into any workspace surface, and neither
-- the mint route nor the fetch route returns it to a customer
-- session: the fetch route answers device-token callers only.
--
-- The single row is enforced by the primary key check (id = 1).
--
-- Numbering: 085 is the next free number after 084 on main at build
-- time (2026-11-12). Independently idempotent (create if not
-- exists), like its neighbours. NOT applied by the build; it is
-- applied on the box road. The signer is fail-soft until it lands:
-- with the table missing, the mint route answers 503 and mints
-- nothing.
create table if not exists helmion.watch_ticket_secret (
  id integer primary key check (id = 1),
  secret text not null check (char_length(secret) between 32 and 512),
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now()
);
alter table helmion.watch_ticket_secret enable row level security;
