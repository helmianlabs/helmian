import {
  fail, hashSecret, randomToken, readJson, requiredSecret, sendJson, validateNonce,
} from './_herald-core.js';
import {
  DESKTOP_CREDENTIAL_TTL_MS, ENROLLMENT_TTL_MS,
  hashEnrollmentCode, normalizeConfirmationCode,
  validateEnrollmentRedemption, validateEnrollmentRequest,
} from './_herald-account-core.js';
import {
  cleanupAccountControl, confirmDesktopEnrollment, createDesktopEnrollment,
  consumeAccountNonce, redeemDesktopEnrollment,
} from './_herald-account-store.js';
import {
  accountIdentityResolver, assertAccountIdentityConfigured, requireVerifiedAccount,
} from './_herald-identity.js';

export function createHeraldEnrollmentHandler({
  accountResolver = accountIdentityResolver,
  store = {
    cleanup: cleanupAccountControl,
    confirm: confirmDesktopEnrollment,
    consumeAccountNonce,
    create: createDesktopEnrollment,
    redeem: redeemDesktopEnrollment,
  },
  enrollmentPepper = () => requiredSecret('HELMION_HERALD_ENROLLMENT_PEPPER'),
  now = Date.now,
  random = randomToken,
} = {}) {
  return async function handler(request, response) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return;
    }
    try {
      assertAccountIdentityConfigured(accountResolver);
      const body = await readJson(request);
      const action = String(body?.action ?? '');
      const pepper = enrollmentPepper();

      if (action === 'request') {
        const value = validateEnrollmentRequest(body);
        const expiresAt = new Date(now() + ENROLLMENT_TTL_MS);
        await store.create({
          enrollmentId: value.enrollmentId,
          proofHash: hashSecret(value.proofSecret),
          confirmationCodeHash: hashEnrollmentCode(value.confirmationCode, pepper),
          displayName: value.displayName,
          expiresAt,
        });
        void store.cleanup().catch(() => {});
        sendJson(response, 201, {
          pending: true,
          enrollmentId: value.enrollmentId,
          expiresAt: expiresAt.toISOString(),
          confirmationRequired: true,
        });
        return;
      }

      if (action === 'confirm') {
        const account = await requireVerifiedAccount(accountResolver, request);
        await store.consumeAccountNonce({
          account, nonce: validateNonce(request.headers['x-helmian-nonce']),
        });
        const confirmationCode = normalizeConfirmationCode(body.confirmationCode);
        const confirmed = await store.confirm({
          confirmationCodeHash: hashEnrollmentCode(confirmationCode, pepper),
          account,
        });
        sendJson(response, 200, {
          confirmed: true,
          enrollmentId: confirmed.enrollment_id,
          desktopDisplayName: confirmed.desktop_display_name,
          expiresAt: new Date(confirmed.expires_at).toISOString(),
        });
        return;
      }

      if (action === 'redeem') {
        const value = validateEnrollmentRedemption(body);
        const desktopId = `desktop_${random(18)}`;
        const registrationToken = random();
        const credentialExpiresAt = new Date(now() + DESKTOP_CREDENTIAL_TTL_MS);
        const enrolled = await store.redeem({
          enrollmentId: value.enrollmentId,
          proofSecret: value.proofSecret,
          desktopId,
          registrationTokenHash: hashSecret(registrationToken),
          credentialExpiresAt,
        });
        sendJson(response, 201, {
          enrolled: true,
          desktopId: enrolled.desktop_id,
          displayName: enrolled.display_name,
          registrationToken,
          credentialExpiresAt: new Date(enrolled.credential_expires_at).toISOString(),
        });
        return;
      }

      sendJson(response, 404, {
        error: 'action_not_available',
        message: 'That Desktop enrollment action is not available.',
      });
    } catch (error) { fail(response, error); }
  };
}

export default createHeraldEnrollmentHandler();
