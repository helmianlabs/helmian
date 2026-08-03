import pg from 'pg';
import { hashProof, httpError, safeEqualHash } from './_team-oauth-core.js';

let pool;

function database() {
  const connectionString = String(process.env.HELMION_TEAM_OAUTH_DATABASE_URL ?? '').trim();
  if (!connectionString) throw httpError(503, 'handoff_not_configured', 'The hosted handoff database is not configured.');
  pool ??= new pg.Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    // Neon and most hosted Postgres terminate plain TCP; verify-full can fail on
    // edge runtimes when the CA bundle differs. Prefer TLS with relaxed verify.
    ssl: connectionString.includes('sslmode=disable')
      ? undefined
      : { rejectUnauthorized: false },
  });
  return pool;
}

function providerId(value) {
  const provider = String(value ?? '');
  if (!['slack', 'discord'].includes(provider)) {
    throw httpError(400, 'invalid_provider', 'The authorization provider is invalid.');
  }
  return provider;
}

export async function registerHandoff({ provider, requestId, stateHash, redemptionChallenge }) {
  provider = providerId(provider);
  await database().query(
    `delete from team_oauth_handoffs where expires_at < now() - interval '1 hour'`,
  );
  const result = await database().query(
    `insert into team_oauth_handoffs
       (request_id, provider, state_hash, redemption_challenge, expires_at)
     values ($1, $2, $3, $4, now() + interval '10 minutes')
     on conflict (request_id) do nothing
     returning expires_at`,
    [requestId, provider, stateHash, redemptionChallenge],
  );
  if (result.rowCount !== 1) throw httpError(409, 'handoff_exists', 'This handoff request already exists.');
  return { expiresAtUtc: result.rows[0].expires_at };
}

export async function completeHandoff({ provider, requestId, stateHash, encryptedCode, providerError }) {
  provider = providerId(provider);
  const client = await database().connect();
  let finished = false;
  try {
    await client.query('begin');
    const result = await client.query(
      `select * from team_oauth_handoffs where request_id=$1 and provider=$2 for update`,
      [requestId, provider],
    );
    const row = result.rows[0];
    if (!row
        || new Date(row.expires_at).getTime() <= Date.now()
        || row.completed_at
        || row.redeemed_at
        || !safeEqualHash(stateHash, row.state_hash)) {
      throw httpError(400, 'invalid_callback', 'The authorization callback is invalid or expired.');
    }
    await client.query(
      `update team_oauth_handoffs
       set code_ciphertext=$2, code_iv=$3, code_tag=$4, provider_error=$5, completed_at=now()
       where request_id=$1`,
      [
        requestId,
        encryptedCode?.ciphertext ?? null,
        encryptedCode?.iv ?? null,
        encryptedCode?.tag ?? null,
        providerError ? 'declined' : null,
      ],
    );
    await client.query('commit');
    finished = true;
  } catch (error) {
    if (!finished) await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function redeemHandoff({ provider, requestId, redemptionSecret }) {
  provider = providerId(provider);
  const client = await database().connect();
  let finished = false;
  try {
    await client.query('begin');
    const result = await client.query(
      `select * from team_oauth_handoffs where request_id=$1 and provider=$2 for update`,
      [requestId, provider],
    );
    const row = result.rows[0];
    if (!row || row.failed_attempts >= 5
        || !safeEqualHash(hashProof(redemptionSecret), row.redemption_challenge)) {
      if (row && row.failed_attempts < 5) {
        await client.query(
          `update team_oauth_handoffs set failed_attempts=failed_attempts+1 where request_id=$1`,
          [requestId],
        );
        await client.query('commit');
        finished = true;
      }
      throw httpError(401, 'handoff_denied', 'The one-time handoff proof was denied.');
    }
    if (new Date(row.expires_at).getTime() <= Date.now() || row.redeemed_at) {
      throw httpError(410, 'handoff_expired', 'The one-time handoff is expired or already used.');
    }
    if (!row.completed_at) {
      await client.query('commit');
      finished = true;
      return { state: 'pending' };
    }
    await client.query(
      `update team_oauth_handoffs
       set redeemed_at=now(), code_ciphertext=null, code_iv=null, code_tag=null
       where request_id=$1`,
      [requestId],
    );
    await client.query('commit');
    finished = true;
    if (row.provider_error) return { state: 'declined' };
    if (!row.code_ciphertext || !row.code_iv || !row.code_tag) {
      throw httpError(500, 'handoff_corrupt', 'The one-time handoff is incomplete.');
    }
    return {
      state: 'complete',
      encryptedCode: {
        ciphertext: row.code_ciphertext,
        iv: row.code_iv,
        tag: row.code_tag,
      },
    };
  } catch (error) {
    if (!finished) await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
