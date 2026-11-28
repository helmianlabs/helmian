-- Provenance weighting profiles (Scribe 1154, Milestone 4 + live bite 4):
-- one row per tenant holding the tenant's provenance weighting profile as
-- the Milestone 4 sync payload (profile + the policy it builds, validated
-- as a unit by src/core/provenance-profile-sync.mjs before it is stored).
-- The Helmian settings surface reads and writes this row through
-- src/cloud/provenance-profile-repository.mjs; Profile Sync carries the
-- same payload down to the tenant's devices as
-- .helmion/provenance/weighting-profile.json.
create table if not exists helmion.provenance_weighting_profiles (
  tenant_id text primary key,
  payload jsonb not null,
  updated_by_subject text not null,
  updated_at timestamptz not null default clock_timestamp()
);
