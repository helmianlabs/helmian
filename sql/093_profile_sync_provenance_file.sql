-- Profile Sync carries the provenance weighting profile (Scribe 1154,
-- bite 5): at enqueue time the job stamps the tenant's provenance payload
-- rendered as the exact file bytes for .helmion/provenance/weighting-profile.json
-- (src/core/provenance-profile-sync.mjs renderProvenanceProfileFile), so
-- the claiming bridge writes byte-identical content and the job's
-- expected_files carries its sha256 under the 'workspace' target for the
-- read-back check, the same verification the Agent OS kit files get.
alter table helmion.profile_sync_jobs
  add column if not exists provenance_file jsonb;
