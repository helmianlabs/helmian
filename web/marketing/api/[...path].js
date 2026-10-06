import heraldConfig from '../server/herald-config.js';
import heraldControl from '../server/herald-control.js';
import heraldDesktop from '../server/herald-desktop.js';
import heraldDesktops from '../server/herald-desktops.js';
import heraldEnrollment from '../server/herald-enrollment.js';
import heraldPair from '../server/herald-pair.js';
import heraldPhone from '../server/herald-phone.js';
import heraldRealtimeToken from '../server/herald-realtime-token.js';
import heraldDesktopRealtimeToken from '../server/herald-desktop-realtime-token.js';
import heraldSession from '../server/herald-session.js';
import billingCheckout from '../server/billing/checkout.js';
import billingDownload from '../server/billing/download.js';
import billingWebhook from '../server/billing/webhook.js';
import { slackHandoffHandlers } from './_team-oauth-slack.js';
import { discordHandoffHandlers } from './_team-oauth-discord.js';

const routes = {
  'herald-config': heraldConfig,
  'herald-control': heraldControl,
  'herald-desktop': heraldDesktop,
  'herald-desktops': heraldDesktops,
  'herald-enrollment': heraldEnrollment,
  'herald-pair': heraldPair,
  'herald-phone': heraldPhone,
  'herald-realtime-token': heraldRealtimeToken,
  'herald-desktop-realtime-token': heraldDesktopRealtimeToken,
  'herald-session': heraldSession,
  'billing/checkout': billingCheckout,
  'billing/download': billingDownload,
  'billing/webhook': billingWebhook,
  'remote/v1/control': heraldControl,
  'remote/v1/control-token': heraldRealtimeToken,
  'remote/v1/desktop': heraldDesktop,
  'remote/v1/desktop-token': heraldDesktopRealtimeToken,
  'remote/v1/desktops': heraldDesktops,
  'remote/v1/enrollment': heraldEnrollment,
  'team-oauth/slack/start': slackHandoffHandlers.start,
  'team-oauth/slack/callback': slackHandoffHandlers.callback,
  'team-oauth/slack/redeem': slackHandoffHandlers.redeem,
  'team-oauth/discord/start': discordHandoffHandlers.start,
  'team-oauth/discord/callback': discordHandoffHandlers.callback,
  'team-oauth/discord/redeem': discordHandoffHandlers.redeem,
};

export default function handler(request, response) {
  const raw = request.query?.path;
  const parts = Array.isArray(raw) ? raw : String(raw || '').split('/').filter(Boolean);
  const route = routes[parts.join('/')];
  if (!route) {
    response.statusCode = 404;
    response.setHeader?.('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  return route(request, response);
}
