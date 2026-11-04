// Self-service signup: creates a trial tenant for a new Clerk user.
// POST /api/signup — requires Clerk auth, creates tenant + owner membership.
// This is the "one thing" for Bryce: signup → trial → /app, end to end.

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createIdentityGateway } from './identity-gateway.mjs';
import { NOTICE_SUBJECT } from './envoy-agents.mjs';
import { ASLEEP_NO_PROVIDER_LINE, computeTenantAgentState } from './tenant-agent-state.mjs';

export const SIGNUP_PATH = '/api/signup';

// The starter channel every new workspace opens with — the same channel
// the /app client used to create lazily on first load, now seeded at
// signup so the workspace is never an empty room, with a welcome notice
// that says the quiet part out loud: until a subscription is connected,
// messages are saved and nobody answers yet.
export const STARTER_CHANNEL = Object.freeze({ slug: 'team', title: 'Team', kind: 'team' });
export const STARTER_WELCOME_BODY = `Welcome to Helmian — this is your first channel, and anything you post here is saved. ${ASLEEP_NO_PROVIDER_LINE} Connect one from Integrations, then open Helmian on your PC so your computer can run them.`;

// Own pool and identity gateway (live-admin.mjs is frozen, can't pass its instances through)
let _pool = null;
let _identity = null;

function getPool() {
  if (!_pool) {
    // Vercel sets HELMION_DATABASE_URL (same as live-admin); DATABASE_URL was never set there.
    const connectionString = process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error('HELMION_DATABASE_URL not set');
    _pool = new Pool({ connectionString, max: 3 });
  }
  return _pool;
}

function getIdentity() {
  if (!_identity) {
    _identity = createIdentityGateway({ env: process.env, fetchImpl: fetch });
  }
  return _identity;
}

// Clerk browser session token (get-started page). Same instance and authorized
// parties as Herald; subject is the Clerk user id, as in the OIDC session.
export async function verifyClerkSessionBearer(token, env = process.env) {
  const secretKey = String(env.CLERK_SECRET_KEY ?? '').trim();
  if (!token || !secretKey) return null;
  const { verifyToken } = await import('@clerk/backend');
  const authorizedParties = String(env.HELMION_HERALD_CLERK_AUTHORIZED_PARTIES ?? '')
    .split(',').map((v) => v.trim()).filter(Boolean);
  const claims = await verifyToken(token, { secretKey, ...(authorizedParties.length ? { authorizedParties } : {}) });
  return typeof claims?.sub === 'string' && /^user_[A-Za-z0-9_-]{4,120}$/.test(claims.sub) ? { subject: claims.sub } : null;
}

function cookieValue(request, name) {
  const header = request.headers?.cookie || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Matches REMEMBERED_SESSION_MS in identity-gateway.mjs and the OIDC
// callback's cookie in live-admin.mjs: /app sign-ins are remembered 30 days.
const APP_SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function createSignupHandler({ getIdentityImpl = getIdentity, verifyBearer = verifyClerkSessionBearer, getPoolImpl = getPool } = {}) {
  return async function handleSignup(request, response) {
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Verify session: the Clerk Bearer token is the identity that just
    // signed up, so it decides. The app-session cookie is only a fallback
    // for callers presenting no token — cookie-first let a stale remembered
    // session in this browser outrank the fresh signup's own identity.
    let claimed = null;
    let identity = null;
    try {
      identity = getIdentityImpl();
      const auth = request.headers?.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (token) {
        try { claimed = await verifyBearer(token); } catch { claimed = null; }
      }
      if (!claimed?.subject) {
        const cookieSession = cookieValue(request, 'helmion_admin_session');
        if (cookieSession) {
          claimed = identity.getSession(cookieSession);
        }
      }
    } catch {
      // claimed stays null
    }

    const subject = claimed?.subject;
    if (!subject) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Not authenticated' }));
      return;
    }

    // Rotate the browser's app session onto the subject that just proved
    // itself here. /app resolves identity and workspace from the
    // helmion_admin_session cookie alone, and that cookie is otherwise set
    // only by the OIDC callback — without this rotation, a browser holding
    // a previous user's remembered session keeps landing in that user's
    // workspace after a fresh signup, and its writes land in that tenant.
    // Cookie shape mirrors the OIDC callback's (live-admin.mjs): same name
    // at both paths, remembered lifetime. Best-effort: the tenant outcome
    // below is already decided and must not fail with the rotation.
    const appSessionCookies = async () => {
      try {
        if (typeof identity?.createSession !== 'function') return [];
        const { sessionId } = await identity.createSession({ subject, remember: true });
        if (!sessionId) return [];
        const options = (path) => `Path=${path}; HttpOnly; Secure; SameSite=Lax`;
        return ['/admin', '/api/admin'].map((path) => `helmion_admin_session=${sessionId}; Max-Age=${APP_SESSION_COOKIE_MAX_AGE_SECONDS}; ${options(path)}`);
      } catch { return []; }
    };

    let client;
    try {
      client = await getPoolImpl().connect();
    } catch (error) {
      console.error('[signup] database unavailable:', error.message);
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Signup is temporarily unavailable, try again shortly' }));
      return;
    }
    try {
      // Check if user already has a tenant
      const existing = await client.query(
        'select tenant_id from helmion.tenant_memberships where subject=$1 and active order by tenant_id limit 1',
        [subject]
      );
      if (existing.rowCount > 0) {
        const cookies = await appSessionCookies();
        response.writeHead(200, { 'content-type': 'application/json', ...(cookies.length ? { 'set-cookie': cookies } : {}) });
        response.end(JSON.stringify({
          tenantId: existing.rows[0].tenant_id,
          created: false,
          message: 'Already have a workspace'
        }));
        return;
      }

      // Create new trial tenant
      const tenantId = randomUUID();
      const displayName = `Trial workspace`;

      await client.query('begin');

      await client.query(
        'insert into helmion.tenants(tenant_id, display_name) values ($1,$2)',
        [tenantId, displayName]
      );

      await client.query(
        "insert into helmion.tenant_memberships(tenant_id, subject, role, active) values ($1,$2,'owner',true)",
        [tenantId, subject]
      );

      // Starter seeding: one channel + the welcome notice, same
      // transaction, both additive (a replayed signup conflicts into
      // no-ops rather than duplicating either).
      const channel = await client.query(
        `insert into helmion.envoy_channels(tenant_id, slug, title, kind, created_by_subject)
         values ($1,$2,$3,$4,$5)
         on conflict (tenant_id, slug) do nothing
         returning id`,
        [tenantId, STARTER_CHANNEL.slug, STARTER_CHANNEL.title, STARTER_CHANNEL.kind, subject]
      );
      const channelId = channel.rows?.[0]?.id ?? null;
      if (channelId) {
        await client.query(
          `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key)
           values ($1,$2,$3,'system',$4,$5)
           on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing`,
          [tenantId, channelId, NOTICE_SUBJECT, STARTER_WELCOME_BODY, `welcome:${tenantId}`]
        );
      }

      await client.query('commit');

      const cookies = await appSessionCookies();
      response.writeHead(201, { 'content-type': 'application/json', ...(cookies.length ? { 'set-cookie': cookies } : {}) });
      response.end(JSON.stringify({
        tenantId,
        created: true,
        message: 'Trial workspace created',
        // A brand-new tenant has no runner and no connected provider:
        // the workspace starts asleep, and the response says so.
        agentState: computeTenantAgentState({}),
      }));
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      console.error('[signup] failed:', error.message);
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Signup failed, try again' }));
    } finally {
      client.release();
    }
  };
}
