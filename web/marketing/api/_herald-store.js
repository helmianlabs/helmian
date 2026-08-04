import pg from 'pg';
import { hashSecret, httpError, safeEqualHash } from './_herald-core.js';

let pool;

export function database() {
  const connectionString = String(process.env.HELMION_HERALD_DATABASE_URL ?? '').trim();
  if (!connectionString) throw new Error('HELMION_HERALD_DATABASE_URL is not configured');
  pool ??= new pg.Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    // Added 2026-08-03. There was no `ssl` key here at all, and node-postgres
    // does NOT imply TLS — so if HELMION_HERALD_DATABASE_URL were ever set
    // without `sslmode=require`, device token hashes, pairing nonces and control
    // grants would cross the network in clear text and nothing in the code could
    // notice. TLS is the default now rather than a property of a connection
    // string somebody has to remember to get right.
    //
    // `rejectUnauthorized: false` deliberately MATCHES the sibling pool in
    // _team-oauth-store.js and is not tightened here. Turning full verification
    // on against a live hosted database can only be validated against the real
    // endpoint and its CA bundle, not from a test run, and doing it blind on a
    // running service is how a site goes down overnight. It is written up for
    // the owner to decide instead.
    ssl: connectionString.includes('sslmode=disable')
      ? undefined
      : { rejectUnauthorized: false },
  });
  return pool;
}

export async function createSession({ channel, desktopTokenHash, pairingCodeHash, pairingExpiresAt, expiresAt }) {
  await database().query(
    `insert into herald_sessions
       (channel, desktop_token_hash, pairing_code_hash, pairing_expires_at, expires_at)
     values ($1,$2,$3,$4,$5)`,
    [channel, desktopTokenHash, pairingCodeHash, pairingExpiresAt, expiresAt],
  );
}

export async function sessionForDesktop(channel, desktopToken) {
  const result = await database().query(
    `select * from herald_sessions
     where channel=$1 and stopped_at is null and expires_at > now()`, [channel],
  );
  const session = result.rows[0];
  if (!session || !safeEqualHash(hashSecret(desktopToken), session.desktop_token_hash)) {
    throw httpError(401, 'desktop_denied', 'Desktop session is invalid or expired.');
  }
  await database().query('update herald_sessions set last_desktop_seen_at=now() where channel=$1', [channel]);
  return session;
}

export async function stopSession(channel, desktopToken) {
  await sessionForDesktop(channel, desktopToken);
  await database().query('update herald_sessions set stopped_at=now() where channel=$1', [channel]);
}

export async function pairDevice({ channel, pairingCodeHash, deviceId, tokenHash, displayName, scopes, expiresAt }) {
  const client = await database().connect();
  let transactionFinished = false;
  try {
    await client.query('begin');
    const result = await client.query(
      `select * from herald_sessions where channel=$1 and stopped_at is null
       and expires_at > now() and pairing_expires_at > now() for update`, [channel],
    );
    const session = result.rows[0];
    if (!session || session.pairing_failed_attempts >= 10) {
      throw httpError(401, 'pairing_denied', 'Pairing code is invalid or expired.');
    }
    if (!safeEqualHash(pairingCodeHash, session.pairing_code_hash)) {
      await client.query('update herald_sessions set pairing_failed_attempts=pairing_failed_attempts+1 where channel=$1', [channel]);
      await client.query('commit');
      transactionFinished = true;
      throw httpError(401, 'pairing_denied', 'Pairing code is invalid or expired.');
    }
    await client.query(
      `insert into herald_devices
       (channel, device_id, token_hash, display_name, scopes, expires_at)
       values ($1,$2,$3,$4,$5,$6)`,
      [channel, deviceId, tokenHash, displayName, scopes, expiresAt],
    );
    await client.query('update herald_sessions set pairing_expires_at=now() where channel=$1', [channel]);
    await client.query('commit');
    transactionFinished = true;
  } catch (error) {
    if (!transactionFinished) await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function authorizeDevice({ channel, deviceId, token, scope, nonce }) {
  const client = await database().connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `select d.*, s.last_desktop_seen_at, s.expires_at as session_expires_at from herald_devices d
       join herald_sessions s on s.channel=d.channel
       where d.channel=$1 and d.device_id=$2 and d.revoked_at is null
       and d.expires_at > now() and s.stopped_at is null and s.expires_at > now()
       for update`, [channel, deviceId],
    );
    const device = result.rows[0];
    if (!device || !safeEqualHash(hashSecret(token), device.token_hash) || !device.scopes.includes(scope)) {
      throw httpError(401, 'device_denied', 'This phone is unpaired, expired, revoked, or out of scope.');
    }
    if (Date.now() - new Date(device.last_desktop_seen_at).getTime() > 45_000) {
      throw httpError(503, 'desktop_offline', 'Helmian Desktop is offline or stale.');
    }
    try {
      await client.query('insert into herald_nonces(channel,device_id,nonce) values ($1,$2,$3)', [channel, deviceId, nonce]);
    } catch (error) {
      if (error?.code === '23505') throw httpError(401, 'replay_denied', 'This request was already used.');
      throw error;
    }
    await client.query('update herald_devices set last_seen_at=now() where channel=$1 and device_id=$2', [channel, deviceId]);
    await client.query('commit');
    return device;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function addMessage(channel, sender, requestId, body) {
  await database().query(
    `insert into herald_messages(channel,sender,request_id,body) values ($1,$2,$3,$4)
     on conflict(channel,sender,request_id) do nothing`,
    [channel, sender, requestId, body],
  );
}

export async function messagesAfter(channel, sender, after) {
  const result = await database().query(
    `select id,body,created_at from herald_messages
     where channel=$1 and sender=$2 and id>$3 order by id asc limit 50`,
    [channel, sender, after],
  );
  return result.rows.map((row) => ({ id: Number(row.id), body: row.body, at: row.created_at }));
}

export async function revokeDevice(channel, desktopToken, deviceId) {
  await sessionForDesktop(channel, desktopToken);
  await database().query('update herald_devices set revoked_at=now() where channel=$1 and device_id=$2', [channel, deviceId]);
}

export async function listDevices(channel, desktopToken) {
  await sessionForDesktop(channel, desktopToken);
  const result = await database().query(
    `select device_id,display_name,scopes,created_at,last_seen_at,expires_at,revoked_at
     from herald_devices where channel=$1 order by created_at`, [channel],
  );
  return result.rows;
}

export async function cleanupExpired() {
  await database().query(`delete from herald_sessions where expires_at < now() - interval '24 hours' or stopped_at < now() - interval '24 hours'`);
  await database().query(`delete from herald_nonces where created_at < now() - interval '24 hours'`);
}
