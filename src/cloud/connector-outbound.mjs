// Connector outbound HTTP surface: the /admin "Send test message" control.
// Kept in this module (next to the concept) so the live admin handler only
// imports and delegates. Webhook URLs are never displayed or accepted here;
// the endpoint only enqueues into helmion.connector_outbound_messages, and
// the drain worker delivers. Owner/admin-only.

import { enqueueConnectorMessage } from '../cora/connector-outbound-worker.mjs';

export const CONNECTOR_OUTBOX_TEST_PATH = '/api/admin/connectors/outbox/test';

const PROVIDERS = new Set(['discord', 'slack']);

export async function handleConnectorOutboundRoute({ request, response, requestUrl, pool, activeActor, send, readJsonObject, exactKeys, TenantAuthorizationError }) {
  if (request.method === 'POST' && requestUrl.pathname === CONNECTOR_OUTBOX_TEST_PATH) {
    try {
      const actor = await activeActor(request);
      if (!['owner', 'admin'].includes(String(actor?.role ?? '').toLowerCase())) {
        throw Object.assign(new Error('connector test delivery requires owner or admin membership'), { status: 403 });
      }
      const body = await readJsonObject(request);
      exactKeys(body, ['provider']);
      const provider = String(body.provider ?? '').trim().toLowerCase();
      if (!PROVIDERS.has(provider)) throw new Error('connector provider is unsupported');
      const enqueued = await enqueueConnectorMessage({
        pool,
        tenantId: actor.tenantId,
        provider,
        channelLabel: 'test',
        text: `Helmian test message from ${actor.subject ?? 'an Organization admin'}: outbound ${provider} delivery is working.`,
      });
      if (!enqueued.queued) {
        send(response, 503, JSON.stringify({ valid: false, code: 'CONNECTOR_OUTBOX_UNAVAILABLE' }));
        return true;
      }
      send(response, 200, JSON.stringify({ valid: true, queued: true, messageId: enqueued.messageId, provider }));
    } catch (error) {
      const status = error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400;
      send(response, status, JSON.stringify({ valid: false, code: status === 403 ? 'CONNECTOR_OUTBOX_ADMIN_REQUIRED' : 'CONNECTOR_OUTBOX_INVALID' }));
    }
    return true;
  }
  return false;
}
