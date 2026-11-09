-- Maestro activation stamp (Troy's design, 2026-11-09): a new person
-- meets Maestro ONCE. At first setup they see who Maestro is and what
-- the bundle is, one click turns it on with their knowledge, and after
-- that it never asks again. Maestro is always-on underneath (the mesh
-- routes desk-style in every channel); this column records that the
-- workspace has had its meeting.
--
--   maestro_activated_at — null means the workspace has not met
--     Maestro yet. The activation route stamps it once, with
--     clock_timestamp(), on the owner's click.
--
-- The backfill below is the "existing workspaces are stamped past
-- it" half of the design: every tenant that exists when this
-- migration is applied is stamped with its own created_at, so no
-- working workspace ever sees the ceremony. Only a tenant created
-- after the apply, born with a null stamp, meets Maestro.
--
-- The tenants row already carries the RLS policy
-- (tenants_current_context, sql/004); the new column inherits it —
-- no policy change is needed. The route fails soft until this
-- migration is applied: a missing column reads as activated, so no
-- workspace is ever blocked by the stamp road.

alter table helmion.tenants
  add column if not exists maestro_activated_at timestamptz;

update helmion.tenants
  set maestro_activated_at = created_at
  where maestro_activated_at is null;
