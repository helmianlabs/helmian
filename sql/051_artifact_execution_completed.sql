-- Artifact execution 'completed' outcome: lets the paired desktop close the
-- loop the cloud worker opens. Migration 046 is already on main (unapplied to
-- prod); this alters its CHECK via a new migration instead of editing 046 so
-- the migration chain stays append-only and prod checksums never drift.
--
-- Lifecycle: the cloud worker records 'needs_desktop' for approved requests;
-- the desktop reports back through POST /api/artifact-execution/result, which
-- transitions the run row needs_desktop -> completed. 'completed' is ONLY
-- writable through that device-authed endpoint — the cloud worker can never
-- observe completion and never writes this outcome. The requests table stays
-- append-only; only the run receipt transitions forward.
alter table helmion.cora_artifact_execution_runs
  drop constraint if exists cora_artifact_execution_runs_outcome_check;
alter table helmion.cora_artifact_execution_runs
  add constraint cora_artifact_execution_runs_outcome_check
  check (outcome in ('needs_desktop', 'failed', 'refused', 'completed'));
