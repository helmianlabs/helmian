// User profile API for Envoy (nickname, avatar)
// GET /api/profile - get current user's profile
// POST /api/profile - set nickname and/or avatar
// Uses its own pg Pool (live-admin.mjs is frozen).

import pg from 'pg';
import { createIdentityGateway } from './identity-gateway.mjs';
import { parseLibraryFaceToken } from '../../web/marketing/app/face-library.mjs';

let _pool = null;
const pool = {
  query: (...args) => {
    if (!_pool) _pool = new pg.Pool({ connectionString: process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL, max: 3 });
    return _pool.query(...args);
  },
};
let _identity = null;
const defaultIdentity = () => (_identity ??= createIdentityGateway({ env: process.env, fetchImpl: fetch }));

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function cookieValue(req, name) {
  const header = req.headers?.cookie || '';
  const m = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export function createProfileHandler({ getIdentity = defaultIdentity } = {}) {
  return async (req, res) => {
    // Verify session (same pattern as signup.mjs)
    let claimed = null;
    try {
      const identity = getIdentity();
      const cookieSession = cookieValue(req, 'helmion_admin_session');
      if (cookieSession) {
        claimed = identity.getSession(cookieSession);
      }
      if (!claimed?.subject) {
        const auth = req.headers?.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (token) {
          claimed = identity.getSession(token);
        }
      }
    } catch {}
    const subject = claimed?.subject;
    if (!subject) {
      return json(res, 401, { error: 'Not authenticated' });
    }

    if (req.method === 'GET') {
      try {
        const r = await pool.query(
          'select nickname, avatar_emoji from helmion.user_profiles where subject = $1',
          [subject]
        );
        const row = r.rows[0];
        return json(res, 200, {
          nickname: row?.nickname ?? null,
          avatarEmoji: row?.avatar_emoji ?? null,
        });
      } catch (e) {
        console.error('[profile] GET failed:', e.message);
        if (e?.code === '42P01') return json(res, 503, { error: 'Profiles are not set up yet', code: 'PROFILE_STORE_MISSING' });
        return json(res, 500, { error: 'Failed to load profile' });
      }
    }

    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }

      const nickname = typeof data.nickname === 'string' ? data.nickname.trim().slice(0, 50) : null;
      // Maestro Library face token
      // ('lib:glossy:<slug>') is longer than an emoji, so the 10-char
      // trim below would silently cut it in half. Accept a token whole
      // when it names a real library piece and refuse it otherwise —
      // a stored face must never point at art that does not exist.
      // Emoji values keep the existing trim, byte for byte.
      let avatarEmoji = null;
      if (typeof data.avatarEmoji === 'string') {
        const rawAvatar = data.avatarEmoji.trim();
        if (rawAvatar.startsWith('lib:')) {
          if (!parseLibraryFaceToken(rawAvatar)) {
            return json(res, 400, { error: 'Unknown library face' });
          }
          avatarEmoji = rawAvatar.slice(0, 64);
        } else {
          avatarEmoji = rawAvatar.slice(0, 10);
        }
      }

      if (nickname !== null && nickname === '') {
        return json(res, 400, { error: 'Nickname cannot be empty' });
      }

      try {
        await pool.query(
          `insert into helmion.user_profiles (subject, nickname, avatar_emoji, updated_at)
           values ($1, $2, $3, now())
           on conflict (subject) do update set
             nickname = coalesce($2, helmion.user_profiles.nickname),
             avatar_emoji = coalesce($3, helmion.user_profiles.avatar_emoji),
             updated_at = now()`,
          [subject, nickname, avatarEmoji]
        );
        return json(res, 200, { ok: true, nickname, avatarEmoji });
      } catch (e) {
        console.error('[profile] POST failed:', e.message);
        if (e?.code === '42P01') return json(res, 503, { error: 'Profiles are not set up yet', code: 'PROFILE_STORE_MISSING' });
        return json(res, 500, { error: 'Failed to save profile' });
      }
    }

    return json(res, 405, { error: 'Method not allowed' });
  };
}
