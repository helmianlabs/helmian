import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  createDesktopEnrollmentIntent, redeemDesktopAccountEnrollment,
  requestDesktopAccountEnrollment,
} from '../src/herald/account-enrollment.mjs';
import {
  loadHeraldDesktopRegistration, saveHeraldDesktopRegistration,
} from '../src/herald/desktop-registration-store.mjs';

const DESKTOP_ID = `desktop_${'d'.repeat(24)}`;
const REGISTRATION_TOKEN = 'r'.repeat(43);

test('Desktop generates separate high-entropy enrollment proof and human code', () => {
  let call = 0;
  const fixtures = [Buffer.alloc(18, 1), Buffer.alloc(32, 2), Buffer.from([0, 0, 0, 42])];
  const intent = createDesktopEnrollmentIntent({ randomBytes: () => fixtures[call++] });
  assert.match(intent.enrollmentId, /^enroll_[A-Za-z0-9_-]{20,80}$/);
  assert.match(intent.proofSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(intent.confirmationCode, '00000042');
  assert.notEqual(intent.proofSecret, intent.confirmationCode);
});

test('Desktop requests enrollment, waits honestly, then redeems one account-bound registration', async () => {
  const intent = createDesktopEnrollmentIntent();
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (body.action === 'request') {
      return jsonResponse(201, { pending: true, expiresAt: '2026-08-02T00:10:00.000Z' });
    }
    if (calls.filter((item) => item.action === 'redeem').length === 1) {
      return jsonResponse(409, { error: 'enrollment_pending', message: 'Awaiting confirmation.' });
    }
    return jsonResponse(201, {
      enrolled: true, desktopId: DESKTOP_ID, displayName: 'Troy desktop',
      registrationToken: REGISTRATION_TOKEN,
      credentialExpiresAt: '2026-09-01T00:00:00.000Z',
    });
  };
  const requested = await requestDesktopAccountEnrollment({
    origin: 'https://helmian.vercel.app', displayName: 'Troy desktop', intent, fetchImpl,
  });
  assert.equal(requested.state, 'awaiting-account-confirmation');
  assert.equal(requested.confirmationCode, intent.confirmationCode);
  assert.equal(requested.confirmationRequired, true);
  assert.equal(requested.confirmationUrl, undefined);
  assert.equal(calls[0].proofSecret, intent.proofSecret);

  const pending = await redeemDesktopAccountEnrollment({
    origin: 'https://helmian.vercel.app', intent, fetchImpl,
  });
  assert.equal(pending.state, 'awaiting-account-confirmation');
  const enrolled = await redeemDesktopAccountEnrollment({
    origin: 'https://helmian.vercel.app', intent, fetchImpl,
  });
  assert.equal(enrolled.state, 'enrolled');
  assert.equal(enrolled.registration.desktopId, DESKTOP_ID);
  assert.equal(enrolled.registration.registrationToken, REGISTRATION_TOKEN);
});

test('Desktop registration is stored with current-user DPAPI, not plaintext', {
  skip: process.platform !== 'win32',
}, async () => {
  const path = join(tmpdir(), `helmian-herald-registration-${process.pid}-${Date.now()}.json`);
  const registration = {
    origin: 'https://helmian.vercel.app', desktopId: DESKTOP_ID,
    displayName: 'Troy desktop', registrationToken: REGISTRATION_TOKEN,
    credentialExpiresAt: '2026-09-01T00:00:00.000Z',
  };
  try {
    await saveHeraldDesktopRegistration(registration, path);
    const disk = await readFile(path, 'utf8');
    assert.doesNotMatch(disk, new RegExp(REGISTRATION_TOKEN));
    assert.match(disk, /Windows CurrentUser DPAPI/);
    const loaded = await loadHeraldDesktopRegistration(path);
    assert.equal(loaded.desktopId, DESKTOP_ID);
    assert.equal(loaded.registrationToken, REGISTRATION_TOKEN);
  } finally { await rm(path, { force: true }); }
});

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
