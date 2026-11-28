-- Profile sync expected kit hashes (FIX-A5, 2026-11-16): a device
-- report used to be believed whole — the job row carried only who
-- asked, so nothing on the cloud side could compare a reported hash
-- against the content the sync was supposed to install, and a report
-- of fabricated hashes rendered as a checkmarked success (audit AT-4,
-- T10 leg 2). Each job now carries, from enqueue time, the expected
-- sha256 of the kit subset whose intended content the cloud can know:
-- the files rendered from the shipped templates/agent-os/ set whose
-- installed bytes do not depend on the PC (companions, AGENT_OS.md,
-- the hook scripts), keyed per target by installed relative path.
-- src/cloud/profile-sync.mjs computes the set with the installer's
-- own render and checks every reported file against it; the page
-- renders kit matches as verified, kit mismatches as FAILED, and
-- everything else as reported by the PC, not verified. Jobs enqueued
-- before this column existed carry NULL and render every file as
-- reported-not-verified — no checkmarks a job did not earn.
alter table helmion.profile_sync_jobs
  add column if not exists expected_files jsonb;
