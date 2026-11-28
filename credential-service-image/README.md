# credential-service-image

A snapshot, taken 2026-11-16, of what was on the live credential-service
image, committed so the running service's source is on record.

What is here:

- `bin/helmion-credential-service.mjs` — the service entry point as it was
  deployed. It differs from the root `bin/helmion-credential-service.mjs`;
  the root copy is the one the repo's tests cover.
- About 60 one-off operator scripts (`apply*.mjs`, `dbpeek*.mjs`,
  `forensic*.mjs`, `hp*.mjs`, `proof*.mjs`, `seat-audit-*.mjs`, …). They were
  written for single checks or fixes against the production database and
  read `HELMION_DATABASE_URL` from the environment. Some carry fixed tenant
  ids for that one job.

Nothing in the build, the tests or CI uses this folder. **Do not run these
scripts** unless you know exactly which database they will touch: several
write to production tables. They are kept, not deleted, so history and
evidence stay intact.
