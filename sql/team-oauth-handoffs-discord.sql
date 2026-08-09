-- Extend the hosted, one-time OAuth handoff to Discord. This migration does
-- not create a shared user credential: each row remains bound to one request,
-- one provider, one callback state, and one redemption proof.
alter table team_oauth_handoffs
  drop constraint if exists team_oauth_handoffs_provider_check;

alter table team_oauth_handoffs
  add constraint team_oauth_handoffs_provider_check
  check (provider in ('slack', 'discord'));
