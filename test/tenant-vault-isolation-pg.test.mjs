// Tenant isolation for the credential vault and the outbound
// destination road, against a real database (Bite H, audit letters
// 724 and 728, Scribe 797 item 4). The vault is where every tenant
// secret lives, so its boundary gets the strongest canaries here: a
// secret stored for tenant A must be unreachable from tenant B by
// every road the code offers, including the dishonest ones (naming
// the other tenant in the reference, claiming the other tenant in
// the actor context, and transplanting the ciphertext row itself
// into tenant B's namespace, where the AAD binding must refuse it).
//
// The destination half runs the production construction end to end:
// destinations stored through the real vault (Bite F's
// storeOutboundDestination), then a drain by a worker built from the
// credential client, over two tenants' queued rows plus a third
// tenant with no destination. The worker's actor is seeded as a
// member of tenants A and B for this test: that models the
// sanctioned-reader decision the Bite F report left open. Production
// has NOT made that decision and the admin drainer is not wired with
// credentials today, so what is proven here is that the vault binding
// itself is tenant-safe given a sanctioned reader, not that the
// production wiring exists.
//
// Runs when HELMIAN_TEST_PG_URL points at a scratch database with the
// repo's sql/ migrations applied, and skips cleanly without one. The
// scratch connection is a superuser, mirroring production's
// RLS-bypass posture: the application boundary is what is proven.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';

const RUN = randomUUID().slice(0, 8);
const A = `ta-${RUN}`;
const B = `tb-${RUN}`;
const C = `tc-${RUN}`;
const SECRET_A = `CANARY-SECRET-A-${RUN}`;
const WORKER_ID = 'worker:iso-test';
const URL_A = `https://discord.com/api/webhooks/iso-a-${RUN}`;
const URL_B = `https://discord.com/api/webhooks/iso-b-${RUN}`;
const URL_ENV = `https://discord.com/api/webhooks/iso-env-${RUN}`;

const ownerA = { actorSubject: 'user-a', actorRole: 'owner', sessionId: 'sess-a', requestId: 'req-a' };
const ownerB = { actorSubject: 'user-b', actorRole: 'owner', sessionId: 'sess-b', requestId: 'req-b' };
const refA = `vault://tenant/${A}/github/main`;
const refB = `vault://tenant/${B}/github/main`;

async function makePool() {
  const { default: pg } = await import('pg');
  return new pg.Pool({ connectionString: pgUrl });
}

async function seedBase(pool, { workerMembership = false } = {}) {
  for (const [tenantId, subject] of [[A, 'user-a'], [B, 'user-b'], [C, 'user-c']]) {
    await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, `Vault Isolation PG ${tenantId}`]);
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role, active) values ($1,$2,$3,true)', [tenantId, subject, 'owner']);
    if (workerMembership && tenantId !== C) {
      await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role, active) values ($1,$2,$3,true)', [tenantId, WORKER_ID, 'member']);
    }
  }
}

async function cleanup(pool) {
  const byTenant = [
    'delete from helmion.audit_outbox where tenant_id=$1',
    'delete from helmion.audit_events where tenant_id=$1',
    'delete from helmion.connector_outbound_messages where tenant_id=$1',
    'delete from helmion.provider_credentials where tenant_id=$1',
    'delete from helmion.tenant_vault_keys where tenant_id=$1',
    'delete from helmion.tenant_memberships where tenant_id=$1',
    'delete from helmion.tenants where tenant_id=$1',
  ];
  for (const tenantId of [A, B, C]) {
    for (const sql of byTenant) await pool.query(sql, [tenantId]).catch(() => {});
  }
}

function makeVault(pool) {
  return import('../src/cloud/credential-vault.mjs').then(({ createCredentialVault }) => createCredentialVault({
    pool,
    masterKey: randomBytes(32).toString('base64url'),
  }));
}

// ------------------------------------------------------------------
// Surface 3: credential vault records.
// ------------------------------------------------------------------

test('vault: a stored secret resolves for its own tenant and by no road for another', { skip: pgSkip }, async () => {
  const pool = await makePool();
  try {
    await seedBase(pool);
    const vault = await makeVault(pool);
    const stored = await vault.storeCredential({
      tenantId: A, ...ownerA, providerId: 'github', credentialReference: refA,
      credentialKind: 'api_key', apiKey: SECRET_A,
    });
    assert.equal(stored.accepted, true, 'tenant A stores its secret');
    const resolved = await vault.resolveCredential({
      tenantId: A, ...ownerA, providerId: 'github', credentialReference: refA, reasonClass: 'provider_call',
    });
    assert.equal(resolved.accepted, true);
    assert.equal(resolved.credential, SECRET_A, 'tenant A resolves its own secret');

    // Road 1: tenant B's context naming tenant A's reference. The
    // reference validation refuses before any lookup.
    await assert.rejects(
      () => vault.resolveCredential({ tenantId: B, ...ownerB, providerId: 'github', credentialReference: refA, reasonClass: 'provider_call' }),
      /reference is invalid/,
      'a reference naming another tenant is refused before lookup',
    );
    // Road 2: tenant B's person claiming tenant A's context. The
    // membership check refuses: user-b is not a member of tenant A.
    await assert.rejects(
      () => vault.resolveCredential({ tenantId: A, ...ownerB, providerId: 'github', credentialReference: refA, reasonClass: 'provider_call' }),
      /not an active member/,
      'a non-member cannot resolve under the other tenant context',
    );
    // Road 3: tenant A's context naming a reference minted for
    // tenant B (which holds nothing): refused by validation, and in
    // no case does tenant A's secret move.
    await assert.rejects(
      () => vault.resolveCredential({ tenantId: A, ...ownerA, providerId: 'github', credentialReference: refB, reasonClass: 'provider_call' }),
      /reference is invalid/,
      'a reference minted for another tenant is refused for this tenant too',
    );
    // Road 4: storing INTO tenant A under tenant B's person is
    // refused by the same membership check.
    await assert.rejects(
      () => vault.storeCredential({ tenantId: A, ...ownerB, providerId: 'github', credentialReference: refA, credentialKind: 'api_key', apiKey: 'intrusion' }),
      /not an active member/,
      'a non-member cannot store into the other tenant',
    );
    // Tenant B resolving its own (empty) address answers not
    // available, never tenant A's material.
    const empty = await vault.resolveCredential({
      tenantId: B, ...ownerB, providerId: 'github', credentialReference: refB, reasonClass: 'provider_call',
    });
    assert.equal(empty.accepted, false);
    assert.equal(empty.status, 'credential_not_available');
    assert.ok(!JSON.stringify(empty).includes(SECRET_A), 'no part of tenant A secret appears in tenant B answer');
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

test('vault: a ciphertext row transplanted into another tenant namespace does not decrypt', { skip: pgSkip }, async () => {
  const pool = await makePool();
  try {
    await seedBase(pool);
    const vault = await makeVault(pool);
    await vault.storeCredential({
      tenantId: A, ...ownerA, providerId: 'github', credentialReference: refA,
      credentialKind: 'api_key', apiKey: SECRET_A,
    });
    // Tenant B holds a vault of its own (its own data key, its own
    // record at its own reference), so the transplant below meets
    // the decrypt path itself, not the missing-key early answer.
    const SECRET_B = `CANARY-SECRET-B-${RUN}`;
    await vault.storeCredential({
      tenantId: B, ...ownerB, providerId: 'github', credentialReference: refB,
      credentialKind: 'api_key', apiKey: SECRET_B,
    });
    // The dishonest copy: tenant A's stored row, rewritten by direct
    // SQL into tenant B's namespace under a fresh tenant B reference.
    // Two layers refuse it: the row's record key is wrapped under
    // tenant A's data key, not tenant B's, and the AAD binds the
    // ciphertext to tenant + provider + reference + kind besides.
    const refBCopy = `vault://tenant/${B}/github/copy`;
    await pool.query(
      `insert into helmion.provider_credentials
         (tenant_id, provider_id, credential_reference, credential_kind, record_key_wrapped, record_key_iv,
          record_key_auth_tag, ciphertext, iv, auth_tag, token_type, scope, expires_at, updated_by_subject)
       select $2, provider_id, $3, credential_kind, record_key_wrapped, record_key_iv,
              record_key_auth_tag, ciphertext, iv, auth_tag, token_type, scope, expires_at, updated_by_subject
         from helmion.provider_credentials where tenant_id=$1 and credential_reference=$4`,
      [A, B, refBCopy, refA],
    );
    await assert.rejects(
      () => vault.resolveCredential({ tenantId: B, ...ownerB, providerId: 'github', credentialReference: refBCopy, reasonClass: 'provider_call' }),
      /could not be decrypted/,
      'the transplanted row refuses to decrypt under tenant B',
    );
    // The AAD layer on its own: the same row copied to a second
    // reference inside tenant A's own namespace (same data key) also
    // refuses, because the reference is part of the bound AAD.
    const refAOther = `vault://tenant/${A}/github/other`;
    await pool.query(
      `insert into helmion.provider_credentials
         (tenant_id, provider_id, credential_reference, credential_kind, record_key_wrapped, record_key_iv,
          record_key_auth_tag, ciphertext, iv, auth_tag, token_type, scope, expires_at, updated_by_subject)
       select tenant_id, provider_id, $2, credential_kind, record_key_wrapped, record_key_iv,
              record_key_auth_tag, ciphertext, iv, auth_tag, token_type, scope, expires_at, updated_by_subject
         from helmion.provider_credentials where tenant_id=$1 and credential_reference=$3`,
      [A, refAOther, refA],
    );
    await assert.rejects(
      () => vault.resolveCredential({ tenantId: A, ...ownerA, providerId: 'github', credentialReference: refAOther, reasonClass: 'provider_call' }),
      /could not be decrypted/,
      'the same row under a different reference refuses too (AAD binds the reference)',
    );
    const after = await vault.resolveCredential({
      tenantId: A, ...ownerA, providerId: 'github', credentialReference: refA, reasonClass: 'provider_call',
    });
    assert.equal(after.credential, SECRET_A, 'tenant A record is untouched by the transplant attempts');
    const afterB = await vault.resolveCredential({
      tenantId: B, ...ownerB, providerId: 'github', credentialReference: refB, reasonClass: 'provider_call',
    });
    assert.equal(afterB.credential, SECRET_B, 'tenant B own record is untouched too');
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

// ------------------------------------------------------------------
// Surface 2: connector outbound destinations through the real vault,
// and the drainer's per-tenant routing and audit scoping.
// ------------------------------------------------------------------

test('outbound: destinations stored in the real vault route each tenant rows only to its own webhook', { skip: pgSkip }, async () => {
  const { createConnectorOutboundWorker, enqueueConnectorMessage } = await import('../src/cora/connector-outbound-worker.mjs');
  const { storeOutboundDestination, readOutboundDestinationState } = await import('../src/cloud/connector-destinations.mjs');
  const pool = await makePool();
  try {
    await seedBase(pool, { workerMembership: true });
    const vault = await makeVault(pool);
    const credentials = {
      resolveVaultCredential: (input) => vault.resolveCredential(input),
      storeCredential: (input) => vault.storeCredential(input),
    };
    const storedA = await storeOutboundDestination({ credentials, tenantId: A, actorContext: ownerA, provider: 'discord', webhookUrl: URL_A });
    assert.equal(storedA.accepted, true, 'tenant A destination stores in the vault');
    const storedB = await storeOutboundDestination({ credentials, tenantId: B, actorContext: ownerB, provider: 'discord', webhookUrl: URL_B });
    assert.equal(storedB.accepted, true, 'tenant B destination stores in the vault');

    const stateA = await readOutboundDestinationState({ credentials, tenantId: A, actorContext: ownerA });
    assert.equal(stateA.discord.configured, true, 'tenant A state reports its destination configured');
    assert.ok(!JSON.stringify(stateA).includes('webhooks'), 'the state read never carries the URL');
    const stateC = await readOutboundDestinationState({ credentials, tenantId: C, actorContext: ownerA });
    assert.equal(stateC.discord.configured, false, 'a read under a foreign tenant context reports nothing configured');

    const msgA = await enqueueConnectorMessage({ pool, tenantId: A, provider: 'discord', text: `CANARY-OUT-A-${RUN}` });
    const msgB = await enqueueConnectorMessage({ pool, tenantId: B, provider: 'discord', text: `CANARY-OUT-B-${RUN}` });
    const msgC = await enqueueConnectorMessage({ pool, tenantId: C, provider: 'discord', text: `CANARY-OUT-C-${RUN}` });
    const posted = [];
    const worker = createConnectorOutboundWorker({
      pool,
      workerId: WORKER_ID,
      env: { HELMION_DISCORD_WEBHOOK_URL: URL_ENV, HELMION_OPERATOR_TENANT_ID: A },
      credentials,
      postMessage: async ({ text, webhookUrl }) => { posted.push({ text, webhookUrl }); return { delivered: true, status: 204 }; },
      log: () => {},
    });
    await worker.runOnce();
    const byText = Object.fromEntries(posted.map((p) => [p.text, p.webhookUrl]));
    assert.equal(byText[`CANARY-OUT-A-${RUN}`], URL_A, 'tenant A row delivered to tenant A webhook (its stored destination beats the env fallback)');
    assert.equal(byText[`CANARY-OUT-B-${RUN}`], URL_B, 'tenant B row delivered to tenant B webhook');
    assert.equal(byText[`CANARY-OUT-C-${RUN}`], undefined, 'tenant C row is delivered nowhere: no destination, and the env webhook does not leak to a non-operator');
    assert.ok(!posted.some((p) => p.webhookUrl === URL_ENV), 'the server-wide env webhook received nothing in this drain');

    const rows = await pool.query('select tenant_id, status, receipt from helmion.connector_outbound_messages where tenant_id = any($1) order by tenant_id', [[A, B, C]]);
    const byTenant = Object.fromEntries(rows.rows.map((r) => [r.tenant_id, r]));
    assert.equal(byTenant[A].status, 'sent');
    assert.equal(byTenant[B].status, 'sent');
    assert.equal(byTenant[C].status, 'failed');
    assert.equal(byTenant[C].receipt.reason, 'tenant_destination_not_configured');

    // The settle audit is written under each row's own tenant, and
    // names only that tenant's message.
    const expected = new Map([[A, msgA.messageId], [B, msgB.messageId], [C, msgC.messageId]]);
    for (const [tenantId, messageId] of expected) {
      const audit = await pool.query(
        "select canonical_target from helmion.audit_events where tenant_id=$1 and action_type like 'connector.outbound.%'",
        [tenantId],
      );
      assert.equal(audit.rowCount, 1, `exactly one outbound audit event under tenant ${tenantId}`);
      assert.ok(JSON.stringify(audit.rows[0].canonical_target).includes(String(messageId)), 'the audit event names its own tenant message');
      for (const [otherTenant, otherId] of expected) {
        if (otherTenant !== tenantId) {
          assert.ok(!JSON.stringify(audit.rows[0].canonical_target).includes(String(otherId)), 'the audit event names no other tenant message');
        }
      }
    }
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});
