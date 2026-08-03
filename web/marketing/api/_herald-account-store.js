import {
  hashSecret, httpError, safeEqualHash,
} from './_herald-core.js';
import {
  publicDesktopRegistry, SESSION_STALE_AFTER_MS,
} from './_herald-account-core.js';
import { database } from './_herald-store.js';

export async function createDesktopEnrollment({
  enrollmentId, proofHash, confirmationCodeHash, displayName, expiresAt,
}) {
  try {
    await database().query(
      `insert into herald_desktop_enrollments
         (enrollment_id,proof_hash,confirmation_code_hash,desktop_display_name,expires_at)
       values ($1,$2,$3,$4,$5)`,
      [enrollmentId, proofHash, confirmationCodeHash, displayName, expiresAt],
    );
  } catch (error) {
    if (error?.code === '23505') {
      throw httpError(409, 'enrollment_collision',
        'Desktop enrollment identity was already used. Generate a fresh request.');
    }
    throw error;
  }
}

export async function confirmDesktopEnrollment({ confirmationCodeHash, account }) {
  const client = await database().connect();
  let transactionFinished = false;
  try {
    await client.query('begin');
    await client.query(
      `insert into herald_accounts(provider,subject,display_name)
       values ($1,$2,$3)
       on conflict(provider,subject) do update set
         display_name=coalesce(excluded.display_name,herald_accounts.display_name),
         last_seen_at=now()`,
      [account.provider, account.subject, account.displayName],
    );
    const limit = await client.query(
      `insert into herald_enrollment_confirmation_limits
         (account_provider,account_subject,attempts)
       values ($1,$2,1)
       on conflict(account_provider,account_subject) do update set
         attempts=case
           when herald_enrollment_confirmation_limits.window_started_at < now() - interval '10 minutes'
             then 1
           else herald_enrollment_confirmation_limits.attempts + 1
         end,
         window_started_at=case
           when herald_enrollment_confirmation_limits.window_started_at < now() - interval '10 minutes'
             then now()
           else herald_enrollment_confirmation_limits.window_started_at
         end
       returning attempts`,
      [account.provider, account.subject],
    );
    if (Number(limit.rows[0]?.attempts) > 10) {
      await client.query('commit');
      transactionFinished = true;
      throw httpError(429, 'enrollment_rate_limited',
        'Too many Desktop enrollment confirmation attempts. Try again later.');
    }
    const result = await client.query(
      `update herald_desktop_enrollments set
         confirmed_account_provider=$2, confirmed_account_subject=$3, confirmed_at=now()
       where confirmation_code_hash=$1 and expires_at > now()
         and confirmed_at is null and redeemed_at is null
       returning enrollment_id,desktop_display_name,expires_at`,
      [confirmationCodeHash, account.provider, account.subject],
    );
    if (!result.rows[0]) {
      await client.query('commit');
      transactionFinished = true;
      throw httpError(401, 'enrollment_denied',
        'Desktop enrollment code is invalid, expired, or already confirmed.');
    }
    await client.query('commit');
    transactionFinished = true;
    return result.rows[0];
  } catch (error) {
    if (!transactionFinished) await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function redeemDesktopEnrollment({
  enrollmentId, proofSecret, desktopId, registrationTokenHash, credentialExpiresAt,
}) {
  const client = await database().connect();
  let transactionFinished = false;
  try {
    await client.query('begin');
    const result = await client.query(
      `select * from herald_desktop_enrollments
       where enrollment_id=$1 and expires_at > now() and redeemed_at is null
       for update`, [enrollmentId],
    );
    const enrollment = result.rows[0];
    if (!enrollment || enrollment.failed_redemption_attempts >= 10
      || !safeEqualHash(hashSecret(proofSecret), enrollment.proof_hash)) {
      if (enrollment) {
        await client.query(
          `update herald_desktop_enrollments
           set failed_redemption_attempts=failed_redemption_attempts+1
           where enrollment_id=$1`, [enrollmentId],
        );
      }
      await client.query('commit');
      transactionFinished = true;
      throw httpError(401, 'enrollment_denied',
        'Desktop enrollment proof is invalid, expired, or already used.');
    }
    if (!enrollment.confirmed_at || !enrollment.confirmed_account_provider
      || !enrollment.confirmed_account_subject) {
      throw httpError(409, 'enrollment_pending',
        'The signed-in account has not confirmed this Desktop enrollment yet.');
    }
    await client.query(
      `insert into herald_registered_desktops
         (desktop_id,account_provider,account_subject,credential_hash,
          credential_expires_at,display_name)
       values ($1,$2,$3,$4,$5,$6)`,
      [desktopId, enrollment.confirmed_account_provider,
        enrollment.confirmed_account_subject, registrationTokenHash,
        credentialExpiresAt, enrollment.desktop_display_name],
    );
    await client.query(
      'update herald_desktop_enrollments set redeemed_at=now() where enrollment_id=$1',
      [enrollmentId],
    );
    await client.query('commit');
    transactionFinished = true;
    return {
      desktop_id: desktopId,
      display_name: enrollment.desktop_display_name,
      credential_expires_at: credentialExpiresAt,
    };
  } catch (error) {
    if (!transactionFinished) await client.query('rollback');
    if (error?.code === '23505') {
      throw httpError(409, 'desktop_identity_collision',
        'Desktop identity collision. Redeem with a fresh server identity.');
    }
    throw error;
  } finally { client.release(); }
}

export async function authorizeRegisteredDesktop({ desktopId, token, nonce }) {
  const client = await database().connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `select * from herald_registered_desktops
       where desktop_id=$1 and revoked_at is null and credential_expires_at > now()
       for update`, [desktopId],
    );
    const desktop = result.rows[0];
    if (!desktop || !safeEqualHash(hashSecret(token), desktop.credential_hash)) {
      throw httpError(401, 'desktop_denied',
        'Desktop registration is invalid, expired, or revoked.');
    }
    try {
      await client.query(
        'insert into herald_desktop_nonces(desktop_id,nonce) values ($1,$2)',
        [desktopId, nonce],
      );
    } catch (error) {
      if (error?.code === '23505') {
        throw httpError(401, 'replay_denied', 'This Desktop request was already used.');
      }
      throw error;
    }
    await client.query(
      'update herald_registered_desktops set last_seen_at=now() where desktop_id=$1',
      [desktopId],
    );
    await client.query('commit');
    return desktop;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function consumeAccountNonce({ account, nonce }) {
  await database().query(
    `insert into herald_accounts(provider,subject,display_name)
     values ($1,$2,$3)
     on conflict(provider,subject) do update set
       display_name=coalesce(excluded.display_name,herald_accounts.display_name),
       last_seen_at=now()`,
    [account.provider, account.subject, account.displayName],
  );
  try {
    await database().query(
      `insert into herald_account_nonces(account_provider,account_subject,nonce)
       values ($1,$2,$3)`, [account.provider, account.subject, nonce],
    );
  } catch (error) {
    if (error?.code === '23505') {
      throw httpError(401, 'replay_denied', 'This account request was already used.');
    }
    throw error;
  }
}

export async function upsertDesktopSession({ desktopId, presence, realtimeChannel, expiresAt }) {
  // Remote Control deliberately exposes one selected desktop session at a time.
  // A clean Desktop restart can mint a new in-memory session id; retire the
  // previous one before publishing the replacement so Herald never offers a
  // stale card that produces a 404 when the phone selects it.
  await database().query(
    `update herald_account_sessions set stopped_at=now()
     where desktop_id=$1 and session_id<>$2 and stopped_at is null`,
    [desktopId, presence.sessionId],
  );
  await database().query(
    `update herald_control_grants set revoked_at=now()
     where desktop_id=$1 and session_id<>$2 and revoked_at is null`,
    [desktopId, presence.sessionId],
  );
  const result = await database().query(
    `insert into herald_account_sessions
       (desktop_id,session_id,project_id,project_name,session_name,session_state,
        agent_id,agent_name,agent_state,guard_state,guard_detail,realtime_channel,expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict(desktop_id,session_id) do update set
       project_id=excluded.project_id,project_name=excluded.project_name,
       session_name=excluded.session_name,session_state=excluded.session_state,
       agent_id=excluded.agent_id,agent_name=excluded.agent_name,
       agent_state=excluded.agent_state,guard_state=excluded.guard_state,
       guard_detail=excluded.guard_detail,last_seen_at=now(),
       expires_at=excluded.expires_at,stopped_at=null
     returning desktop_id,session_id,project_id,project_name,session_name,
       session_state,agent_id,agent_name,agent_state,guard_state,guard_detail,
       realtime_channel,last_seen_at,expires_at`,
    [desktopId, presence.sessionId, presence.project.id, presence.project.name,
      presence.sessionName, presence.state, presence.agent?.id ?? null,
      presence.agent?.name ?? null, presence.agent?.state ?? null,
      presence.guard.state, presence.guard.detail, realtimeChannel, expiresAt],
  );
  return result.rows[0];
}

export async function stopDesktopSession({ desktopId, sessionId }) {
  const result = await database().query(
    `update herald_account_sessions set stopped_at=now()
     where desktop_id=$1 and session_id=$2 and stopped_at is null
     returning session_id`, [desktopId, sessionId],
  );
  if (!result.rows[0]) throw httpError(404, 'session_not_found', 'Active Desktop session was not found.');
  await database().query(
    `update herald_control_grants set revoked_at=now()
     where desktop_id=$1 and session_id=$2 and revoked_at is null`, [desktopId, sessionId],
  );
}

export async function listAccountDesktops(account) {
  const threshold = new Date(Date.now() - SESSION_STALE_AFTER_MS);
  const result = await database().query(
    `select d.desktop_id,d.display_name,d.last_seen_at as desktop_last_seen_at,
       d.credential_expires_at,
       (d.last_seen_at is not null and d.last_seen_at > $3) as desktop_online,
       s.session_id,s.project_id,s.project_name,s.session_name,
       s.session_state,s.agent_id,s.agent_name,s.agent_state,
       s.guard_state,s.guard_detail,s.last_seen_at as session_last_seen_at
     from herald_registered_desktops d
     left join herald_account_sessions s on s.desktop_id=d.desktop_id
       and s.stopped_at is null and s.expires_at > now() and s.last_seen_at > $3
     where d.account_provider=$1 and d.account_subject=$2
       and d.revoked_at is null and d.credential_expires_at > now()
     order by d.enrolled_at,s.last_seen_at desc`,
    [account.provider, account.subject, threshold],
  );
  return publicDesktopRegistry(result.rows);
}

export async function createAccountControlGrant({
  account, desktopId, sessionId, grantId, tokenHash, expiresAt,
}) {
  const threshold = new Date(Date.now() - SESSION_STALE_AFTER_MS);
  const result = await database().query(
    `insert into herald_control_grants
       (grant_id,account_provider,account_subject,desktop_id,session_id,token_hash,expires_at)
     select $5,d.account_provider,d.account_subject,s.desktop_id,s.session_id,$6,$7
     from herald_registered_desktops d
     join herald_account_sessions s on s.desktop_id=d.desktop_id
     where d.desktop_id=$3 and s.session_id=$4
       and d.account_provider=$1 and d.account_subject=$2
       and d.revoked_at is null and d.credential_expires_at > now()
       and d.last_seen_at > $8 and s.stopped_at is null
       and s.expires_at > now() and s.last_seen_at > $8
     returning desktop_id,session_id,expires_at`,
    [account.provider, account.subject, desktopId, sessionId,
      grantId, tokenHash, expiresAt, threshold],
  );
  if (!result.rows[0]) {
    throw httpError(404, 'session_not_available',
      'That account-owned Desktop session is not currently active.');
  }
  return result.rows[0];
}

export async function authorizeAccountControlGrant({ account, grantId, token }) {
  const threshold = new Date(Date.now() - SESSION_STALE_AFTER_MS);
  const result = await database().query(
    `select g.*,d.display_name,d.credential_expires_at as desktop_credential_expires_at,
       s.expires_at as session_expires_at,s.project_id,s.project_name,s.session_name,
       s.session_state,s.agent_id,s.agent_name,s.agent_state,
       s.guard_state,s.guard_detail,s.realtime_channel,s.last_seen_at as session_last_seen_at
     from herald_control_grants g
     join herald_registered_desktops d on d.desktop_id=g.desktop_id
     join herald_account_sessions s on s.desktop_id=g.desktop_id and s.session_id=g.session_id
     where g.grant_id=$1 and g.account_provider=$2 and g.account_subject=$3
       and g.revoked_at is null and g.expires_at > now()
       and d.revoked_at is null and d.credential_expires_at > now() and d.last_seen_at > $4
       and s.stopped_at is null and s.expires_at > now() and s.last_seen_at > $4`,
    [grantId, account.provider, account.subject, threshold],
  );
  const grant = result.rows[0];
  if (!grant || !safeEqualHash(hashSecret(token), grant.token_hash)) {
    throw httpError(401, 'control_denied',
      'Remote Control selection is invalid, expired, revoked, or offline.');
  }
  await database().query(
    'update herald_control_grants set last_seen_at=now() where grant_id=$1', [grantId],
  );
  return grant;
}

export async function authorizeDesktopRealtimeSession({ desktopId, sessionId }) {
  const threshold = new Date(Date.now() - SESSION_STALE_AFTER_MS);
  const sessionResult = await database().query(
    `select s.realtime_channel,s.expires_at as session_expires_at,
       d.credential_expires_at
     from herald_account_sessions s
     join herald_registered_desktops d on d.desktop_id=s.desktop_id
     where s.desktop_id=$1 and s.session_id=$2
       and d.revoked_at is null and d.credential_expires_at > now() and d.last_seen_at > $3
       and s.stopped_at is null and s.expires_at > now() and s.last_seen_at > $3`,
    [desktopId, sessionId, threshold],
  );
  const session = sessionResult.rows[0];
  if (!session) {
    throw httpError(404, 'session_not_available',
      'Registered Desktop session is not currently active.');
  }
  const grantsResult = await database().query(
    `select grant_id,expires_at from herald_control_grants
     where desktop_id=$1 and session_id=$2 and revoked_at is null and expires_at > now()
     order by created_at desc limit 16`, [desktopId, sessionId],
  );
  if (grantsResult.rows.length < 1) {
    throw httpError(409, 'realtime_not_selected',
      'No account has selected this Desktop session for Remote Control.');
  }
  return { ...session, grants: grantsResult.rows };
}

export async function revokeAccountControlGrant({ account, grantId }) {
  const result = await database().query(
    `update herald_control_grants set revoked_at=now()
     where grant_id=$1 and account_provider=$2 and account_subject=$3 and revoked_at is null
     returning grant_id`, [grantId, account.provider, account.subject],
  );
  return Boolean(result.rows[0]);
}

export async function revokeAccountDesktop({ account, desktopId }) {
  const client = await database().connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `update herald_registered_desktops set revoked_at=now()
       where desktop_id=$1 and account_provider=$2 and account_subject=$3
         and revoked_at is null returning desktop_id`,
      [desktopId, account.provider, account.subject],
    );
    if (!result.rows[0]) throw httpError(404, 'desktop_not_found', 'Account-owned Desktop was not found.');
    await client.query(
      'update herald_account_sessions set stopped_at=now() where desktop_id=$1 and stopped_at is null',
      [desktopId],
    );
    await client.query(
      'update herald_control_grants set revoked_at=now() where desktop_id=$1 and revoked_at is null',
      [desktopId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function cleanupAccountControl() {
  await database().query(
    `delete from herald_desktop_enrollments
     where expires_at < now() - interval '24 hours' or redeemed_at < now() - interval '24 hours'`,
  );
  await database().query(
    `delete from herald_desktop_nonces where created_at < now() - interval '24 hours'`,
  );
  await database().query(
    `delete from herald_account_nonces where created_at < now() - interval '24 hours'`,
  );
  await database().query(
    `delete from herald_control_grants
     where expires_at < now() - interval '24 hours' or revoked_at < now() - interval '24 hours'`,
  );
}
