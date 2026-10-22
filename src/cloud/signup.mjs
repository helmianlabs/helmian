// Self-service signup: creates a trial tenant for a new Clerk user.
// POST /api/signup — requires Clerk auth, creates tenant + owner membership.
// This is the "one thing" for Bryce: signup → trial → /app, end to end.

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createIdentityGateway } from './identity-gateway.mjs';

export const SIGNUP_PATH = '/api/signup';

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

export function createSignupHandler({ getIdentityImpl = getIdentity, verifyBearer = verifyClerkSessionBearer, getPoolImpl = getPool } = {}) {
  return async function handleSignup(request, response) {
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Verify session: try cookie first, then Bearer token
    let claimed = null;
    try {
      const identity = getIdentityImpl();
      const cookieSession = cookieValue(request, 'helmion_admin_session');
      if (cookieSession) {
        claimed = identity.getSession(cookieSession);
      }
      if (!claimed?.subject) {
        const auth = request.headers?.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (token) {
          claimed = await verifyBearer(token);
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
        response.writeHead(200, { 'content-type': 'application/json' });
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

      await client.query('commit');

      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        tenantId,
        created: true,
        message: 'Trial workspace created'
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
