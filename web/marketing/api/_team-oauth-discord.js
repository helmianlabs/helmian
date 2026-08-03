// Discord uses the same provider-scoped, one-time hosted handoff as Slack.
// This server never accepts a user's Discord token, bot token, or OAuth secret
// from a browser or desktop. It only holds the short-lived authorization code
// until the corresponding desktop redeems it with its one-time proof.
import { createSlackHandoffHandlers } from './_team-oauth-slack.js';

export const discordHandoffHandlers = createSlackHandoffHandlers({
  provider: 'discord',
  providerLabel: 'Discord',
});
