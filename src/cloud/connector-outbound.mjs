// Connector outbound HTTP surface: the /admin "Send test message" control,
// and (Bite F) the per-tenant outbound destination save/read surface
// beside it. Kept in this module (next to the concept) so the live admin
// handler only imports and delegates. The test endpoint only enqueues
// into helmion.connector_outbound_messages, and the drain worker
// delivers. The destination endpoints accept a workspace's own Discord
// or Slack webhook URL once and store it in the credential vault
// (connector-destinations.mjs); the URL is never displayed, never read
// back, and never logged: reads report only configured or not
// configured, per provider, for the caller's own tenant. Owner/admin-only.

import { randomUUID } from 'node:crypto';
import { enqueueConnectorMessage } from '../cora/connector-outbound-worker.mjs';
import { readOutboundDestinationState, storeOutboundDestination } from './connector-destinations.mjs';

export const CONNECTOR_OUTBOX_TEST_PATH = '/api/admin/connectors/outbox/test';
export const CONNECTOR_OUTBOX_DESTINATION_PATH = '/api/admin/connectors/outbox/destination';

const PROVIDERS = new Set(['discord', 'slack']);

export async function handleConnectorOutboundRoute({ request, response, requestUrl, pool, activeActor, send, readJsonObject, exactKeys, TenantAuthorizationError, credentials = null }) {
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
  if (requestUrl.pathname === CONNECTOR_OUTBOX_DESTINATION_PATH && (request.method === 'POST' || request.method === 'GET')) {
    try {
      const actor = await activeActor(request);
      if (!['owner', 'admin'].includes(String(actor?.role ?? '').toLowerCase())) {
        throw Object.assign(new Error('connector outbound destinations require owner or admin membership'), { status: 403 });
      }
      if (!credentials || typeof credentials.storeCredential !== 'function' || typeof credentials.resolveVaultCredential !== 'function') {
        send(response, 503, JSON.stringify({ valid: false, code: 'CONNECTOR_DESTINATION_UNAVAILABLE' }));
        return true;
      }
      // The vault actor context, in the connector write route's shape:
      // the verified actor's own subject and role, with the session and
      // request ids the session layer minted for this request.
      const actorContext = {
        actorSubject: actor.subject,
        actorRole: actor.role,
        sessionId: actor.sessionId ?? randomUUID(),
        requestId: actor.requestId ?? randomUUID(),
      };
      if (request.method === 'GET') {
        const destinations = await readOutboundDestinationState({ credentials, tenantId: actor.tenantId, actorContext });
        if (!destinations) {
          send(response, 503, JSON.stringify({ valid: false, code: 'CONNECTOR_DESTINATION_UNAVAILABLE' }));
          return true;
        }
        send(response, 200, JSON.stringify({ valid: true, destinations }));
        return true;
      }
      const body = await readJsonObject(request);
      exactKeys(body, ['provider', 'webhookUrl']);
      const provider = String(body.provider ?? '').trim().toLowerCase();
      if (!PROVIDERS.has(provider)) throw new Error('connector provider is unsupported');
      // storeOutboundDestination validates the URL against the host
      // allowlist before anything is stored; its throw lands in the
      // catch below as a 400.
      const stored = await storeOutboundDestination({ credentials, tenantId: actor.tenantId, actorContext, provider, webhookUrl: body.webhookUrl });
      if (!stored) {
        send(response, 503, JSON.stringify({ valid: false, code: 'CONNECTOR_DESTINATION_UNAVAILABLE' }));
        return true;
      }
      if (!stored.accepted) {
        // The vault refused, most often the Guard replacement gate on
        // a destination that already exists (the tenant pair route's
        // mapping). The stored destination, if any, is untouched.
        if (stored.status === 'guard_approval_required') {
          send(response, 409, JSON.stringify({ valid: false, code: 'GUARD_APPROVAL_REQUIRED' }));
          return true;
        }
        if (stored.status === 'guard_gate_not_configured') {
          send(response, 409, JSON.stringify({ valid: false, code: 'GUARD_GATE_NOT_CONFIGURED' }));
          return true;
        }
        send(response, 502, JSON.stringify({ valid: false, code: 'CONNECTOR_DESTINATION_NOT_STORED' }));
        return true;
      }
      send(response, 200, JSON.stringify({ valid: true, configured: true, provider }));
    } catch (error) {
      const status = error?.status === 403 || error instanceof TenantAuthorizationError ? 403 : 400;
      send(response, status, JSON.stringify({ valid: false, code: status === 403 ? 'CONNECTOR_OUTBOX_ADMIN_REQUIRED' : 'CONNECTOR_DESTINATION_INVALID' }));
    }
    return true;
  }
  return false;
}
