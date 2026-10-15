# Cloud console worker

Executes queued `/admin` console commands (table `helmion.console_command_intents`)
and writes one append-only result per command to `helmion.console_command_runs`
(migration `sql/041_console_command_runs.sql`).

| Command | Cloud result |
|---|---|
| workspace_context | counts: active projects, members, agent tasks, verified providers |
| list_agents | provider connections (provider, auth mode, lifecycle; never secrets) |
| open_project | registered project metadata, or `refused` if not registered |
| run_project_task, start/stop_project_preview | `needs_desktop` (no filesystem in the cloud) |

## Run it (free tier only)
1. Apply migrations to Neon: `HELMION_DATABASE_URL=... node bin/helmion.mjs migrate`
2. Either, in the existing Fly app (no new machine, no extra cost):
   `fly secrets set HELMION_CONSOLE_WORKER=1 -a helmian-cloud` then `fly deploy`
3. Or standalone/one-shot anywhere: `HELMION_DATABASE_URL=... node bin/helmion-cloud-worker.mjs [--once]`
   (Render's free tier has no background workers and sleeps web services, so the Fly option is preferred.)
