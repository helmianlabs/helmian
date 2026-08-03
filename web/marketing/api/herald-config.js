import { sendJson } from './_herald-core.js';
import { accountIdentityResolver } from './_herald-identity.js';
import { isAblyConfigured } from './_herald-realtime.js';

export function createHeraldConfigHandler({
  accountConfigured = () => accountIdentityResolver.configured,
  accountConfigurationState = () => accountIdentityResolver.configurationState,
  enrollmentConfigured = () => accountIdentityResolver.configured
    && String(process.env.HELMION_HERALD_ENROLLMENT_PEPPER ?? '').trim().length >= 32,
  realtimeConfigured = () => isAblyConfigured(),
  publishableKey = () => process.env.CLERK_PUBLISHABLE_KEY,
} = {}) {
  return async function handler(request, response) {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
      return;
    }
    sendJson(response, 200, {
      accountIdentity: {
        configured: accountConfigured() === true,
        state: String(accountConfigurationState() ?? 'unconfigured'),
        desktopEnrollmentConfigured: enrollmentConfigured() === true,
        publishableKey: accountConfigured() === true
          ? String(publishableKey() ?? '').trim() || null
          : null,
      },
      transport: {
        active: realtimeConfigured() === true ? 'ably-scoped-realtime' : 'unavailable',
        realtimeClientActive: realtimeConfigured() === true,
        ablyTokenServiceConfigured: realtimeConfigured() === true,
      },
    });
  };
}

export default createHeraldConfigHandler();
