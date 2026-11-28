-- Extend the hosted one-time handoff to GitHub. For GitHub the cloud exchanges the
-- code server-side; the handoff holds the encrypted access token only until the
-- desktop redeems it once (ciphertext is cleared on redemption; rows expire).
alter table team_oauth_handoffs
  drop constraint if exists team_oauth_handoffs_provider_check;

alter table team_oauth_handoffs
  add constraint team_oauth_handoffs_provider_check
  check (provider in ('slack', 'discord', 'github'));
