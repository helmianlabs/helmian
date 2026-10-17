// Workspace agent icons: per-user custom emoji for the fixed provider list
// (Maestro, Claude, ChatGPT, Grok, Gemini). Personal customization only —
// presentation, never authority. Plain emoji_mode does not strip these:
// they are the user's own choice.
//
// Route handling lives here next to the store so the live admin handler only
// imports and delegates (live-admin.mjs is near the push tool's size limit).

import { withTenantTransaction, requireActiveTenantMembership } from '../core/tenant-context.mjs';
import { appendAuditEvent } from './audit-event-repository.mjs';

export const AGENT_ICONS_PATH = '/api/admin/workspace/agent-icons';

export const AGENT_PROVIDERS = Object.freeze(['Maestro', 'Claude', 'ChatGPT', 'Grok', 'Gemini']);

const GRAPHEME = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function assertProviderName(value) {
  const name = String(value ?? '').trim();
  if (!AGENT_PROVIDERS.includes(name)) throw Object.assign(new Error('agent provider is invalid'), { status: 400 });
  return name;
}

// Server-side icon validation. Exactly one grapheme; no control characters,
// tag characters, or invisible format characters (ZWJ and VS16 are allowed
// because they are legitimate parts of emoji sequences). char_length 1–16
// is enforced again by the table CHECK constraint.
export function assertIconEmoji(value) {
  if (value == null) return null; // null clears back to the default icon
  const text = String(value);
  if (!text || /^\s*$/u.test(text)) throw Object.assign(new Error('agent icon must be a single emoji'), { status: 400 });
  if ([...GRAPHEME.segment(text)].length !== 1) throw Object.assign(new Error('agent icon must be a single emoji'), { status: 400 });
  if (/[\p{Cc}\u{E0000}-\u{E007F}]/u.test(text)) throw Object.assign(new Error('agent icon contains unsupported characters'), { status: 400 });
  if (/\p{Cf}/u.test(text.replace(/[\u200D\uFE0F]/g, ''))) throw Object.assign(new Error('agent icon contains unsupported characters'), { status: 400 });
  if ([...text].length > 16) throw Object.assign(new Error('agent icon is too long'), { status: 400 });
  return text;
}

export function createAgentIconStore(pool) {
  if (!pool?.connect) throw new Error('agent icon store needs a Postgres pool');

  function context(actor) {
    return {
      tenantId: actor.tenantId,
      actorSubject: actor.subject,
      actorRole: actor.role,
      sessionId: actor.sessionId,
      requestId: actor.requestId,
    };
  }

  async function readAll(client, ctx) {
    try {
      const result = await client.query(
        `select provider_name, icon_emoji from helmion.workspace_agent_icons
         where tenant_id = $1 and user_subject = $2`,
        [ctx.tenantId, ctx.actorSubject],
      );
      const icons = {};
      for (const name of AGENT_PROVIDERS) icons[name] = null;
      for (const row of result.rows) icons[row.provider_name] = row.icon_emoji;
      return { icons: Object.freeze(icons) };
    } catch (error) {
      // Migration 055 not applied yet: report empty icons instead of failing.
      if (error?.code === '42P01') {
        const icons = {};
        for (const name of AGENT_PROVIDERS) icons[name] = null;
        return { icons: Object.freeze(icons), iconsUnavailable: true };
      }
      throw error;
    }
  }

  return Object.freeze({
    async list(actor) {
      const ctx = context(actor);
      return withTenantTransaction(pool, ctx, async (client) => {
        await requireActiveTenantMembership(client, ctx);
        return readAll(client, ctx);
      });
    },

    async set(actor, input) {
      const providerName = assertProviderName(input?.providerName);
      const iconEmoji = assertIconEmoji(input?.iconEmoji);
      const ctx = context(actor);
      return withTenantTransaction(pool, ctx, async (client) => {
        await requireActiveTenantMembership(client, ctx);
        try {
          if (iconEmoji == null) {
            await client.query(
              `delete from helmion.workspace_agent_icons
               where tenant_id = $1 and user_subject = $2 and provider_name = $3`,
              [ctx.tenantId, ctx.actorSubject, providerName],
            );
          } else {
            await client.query(
              `insert into helmion.workspace_agent_icons (tenant_id, user_subject, provider_name, icon_emoji, updated_by_subject)
               values ($1, $2, $3, $4, $2)
               on conflict (tenant_id, user_subject, provider_name)
               do update set icon_emoji = excluded.icon_emoji, updated_by_subject = excluded.updated_by_subject, updated_at = clock_timestamp()`,
              [ctx.tenantId, ctx.actorSubject, providerName, iconEmoji],
            );
          }
        } catch (error) {
          if (error?.code === '42P01') throw Object.assign(new Error('agent icons are not available yet'), { status: 503 });
          throw error;
        }
        await appendAuditEvent(client, ctx, {
          actionType: 'workspace.agent_icon.saved',
          canonicalTarget: { resource: 'workspace_agent_icon', providerName },
          policyVersion: 'workspace-agent-icons.v1',
          decision: 'ALLOW',
          privacySummary: 'User set a personal display icon for an agent provider; presentation only',
          result: { providerName, cleared: iconEmoji == null, execution: 'not_performed', providerInvocation: 'not_performed' },
        });
        return { durable: true, providerName, iconEmoji };
      });
    },
  });
}

// --- trivial per-actor rate limit (boring by design) ---

const rateBuckets = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

export function checkAgentIconRateLimit(key, now = Date.now()) {
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const hits = (rateBuckets.get(key) ?? []).filter((t) => t > windowStart);
  if (hits.length >= RATE_LIMIT_MAX) return false;
  hits.push(now);
  rateBuckets.set(key, hits);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (v.every((t) => t <= windowStart)) rateBuckets.delete(k);
      if (rateBuckets.size <= 4000) break;
    }
  }
  return true;
}

export function clearAgentIconRateLimits() {
  rateBuckets.clear();
}

// HTTP route handling. Returns true when the request was handled.
export async function handleAgentIconRoute({ request, response, requestUrl, pool, agentIcons, activeTenantActor, send, readJsonObject, exactKeys, TenantAuthorizationError }) {
  const membershipError = (error) => error?.status === 403 || error instanceof TenantAuthorizationError;
  if (requestUrl.pathname !== AGENT_ICONS_PATH) return false;
  const store = agentIcons ?? createAgentIconStore(pool);
  if (request.method === 'GET') {
    try {
      const actor = await activeTenantActor(request);
      send(response, 200, JSON.stringify({ valid: true, ...(await store.list(actor)) }));
    } catch (error) {
      send(response, membershipError(error) ? 403 : 503, JSON.stringify({ valid: false, code: membershipError(error) ? 'AGENT_ICONS_MEMBERSHIP_REQUIRED' : 'AGENT_ICONS_READ_FAILED' }));
    }
    return true;
  }
  if (request.method === 'PUT') {
    try {
      const actor = await activeTenantActor(request);
      if (!checkAgentIconRateLimit(`${actor.tenantId}:${actor.subject}`)) throw Object.assign(new Error('agent icon changes are rate limited'), { status: 429 });
      const body = await readJsonObject(request);
      exactKeys(body, ['providerName', 'iconEmoji']);
      if (Object.prototype.hasOwnProperty.call(body, 'tenantId')) throw new Error('tenant selector is not accepted');
      send(response, 200, JSON.stringify({ valid: true, ...(await store.set(actor, body)) }));
    } catch (error) {
      const status = membershipError(error) ? 403 : error?.status === 429 ? 429 : error?.status === 503 ? 503 : 400;
      send(response, status, JSON.stringify({ valid: false, code: status === 403 ? 'AGENT_ICONS_MEMBERSHIP_REQUIRED' : status === 429 ? 'AGENT_ICONS_RATE_LIMITED' : status === 503 ? 'AGENT_ICONS_MIGRATION_PENDING' : 'AGENT_ICONS_SAVE_INVALID' }));
    }
    return true;
  }
  return false;
}
