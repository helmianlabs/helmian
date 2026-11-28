-- Runner presence: the last-answered stamp (honest-connection fix,
-- 2026-11-01). A presence row can say a device reported a provider or a
-- sync stamped it; neither proves an answer ever happened, so neither may
-- read as a connection. last_answered_at is written only by the
-- reply-posting path (envoy-mesh postAsAgent) at the moment a runner
-- actually posts an agent reply — the one event that proves the road
-- works. The provider cards read "Answered" from this stamp; a provider
-- with no stamp has never answered and does not read as connected.
alter table helmion.runner_provider_presence
  add column if not exists last_answered_at timestamptz;
