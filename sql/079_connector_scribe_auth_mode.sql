-- helmian-scribe auth_mode alignment (scribe-connect fix,
-- 2026-11-09): the catalog definition for helmian-scribe has
-- carried authMode 'oauth' since the Pattern-A correction — the
-- Scribe door is OAuth-only (authorization-code + PKCE, proven by
-- connectors bite 4R's probe) — but rows seeded into
-- helmion.connector_entries while the catalog still said 'none'
-- kept the stale label. The read-route seed refreshes only tenants
-- holding zero entries, so the correction never reached a live
-- tenant's rows, and the M1 write route dispatched connect on the
-- stored label: one click recorded a "No sign-in" connection no
-- consent produced (live exercise, 2026-11-09 09:04–09:08 MST; the
-- false record it created was disconnected the same morning).
--
-- This migration aligns the stored rows with the catalog for every
-- tenant and seat. It is idempotent. The write route no longer
-- trusts a stored label the catalog contradicts (its dispatch runs
-- on the catalog's authMode), so this alignment is the data half
-- of the fix, not the only line of defence — but the OAuth
-- callback's landing needs it: the library store refuses token
-- references for an entry labelled 'none', so a completed door
-- consent could not be recorded against a stale row.
--
-- RLS follows the connector library's pattern (sql/074): the
-- migration road runs as the schema owner in the established
-- apply pattern (advisory lock + ledger row), as with 075–078.

update helmion.connector_entries
   set auth_mode = 'oauth', updated_at = clock_timestamp()
 where id = 'helmian-scribe'
   and auth_mode <> 'oauth';
