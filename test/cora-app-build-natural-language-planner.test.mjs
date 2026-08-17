import assert from 'node:assert/strict';
import test from 'node:test';
import { planAppBuildFromNaturalLanguage } from '../src/cora/app-build-natural-language-planner.mjs';

const hrDraft = Object.freeze({
  intent: 'draft', title: 'Driver self onboarding', department: 'hr', route: '/hr/self-onboarding',
  description: 'Collect and review a new driver onboarding draft.', idempotencyKey: 'nl-plan-hr-0001',
  components: [
    { type: 'heading', text: 'Driver self onboarding' },
    { type: 'field', label: 'Driver email', fieldType: 'email', required: true },
    { type: 'button', label: 'Save draft', action: 'save_draft' },
  ],
});

test('natural-language HR request becomes only an injected bounded declarative draft plan', () => {
  const receipt = planAppBuildFromNaturalLanguage({
    userRequest: 'Cora, build HR a driver self-onboarding dashboard with an email field and a save-draft button.',
    plannerResponse: JSON.stringify(hrDraft),
  });
  assert.equal(receipt.valid, true);
  assert.equal(receipt.normalized.route, '/hr/self-onboarding');
  assert.equal(receipt.normalized.components[1].fieldType, 'email');
  assert.equal(receipt.source.kind, 'injected-structured-planner-response');
  assert.match(receipt.source.userRequestSha256, /^[a-f0-9]{64}$/u);
  for (const flag of ['execution', 'providerInvocation', 'persistence', 'filesystemMutation', 'publication', 'deployment']) assert.equal(receipt[flag], 'not_performed');
});

test('planner rejects missing/malformed and malicious structured responses before any side effect', () => {
  assert.throws(() => planAppBuildFromNaturalLanguage({ userRequest: 'Make HR onboarding.' }), /required/);
  assert.throws(() => planAppBuildFromNaturalLanguage({ userRequest: 'Make HR onboarding.', plannerResponse: '{bad json' }), /valid JSON/);
  assert.throws(() => planAppBuildFromNaturalLanguage({ userRequest: 'Make HR onboarding.', plannerResponse: JSON.stringify({ ...hrDraft, tenantId: 'other-tenant' }) }), /cannot select tenant/);
  assert.throws(() => planAppBuildFromNaturalLanguage({ userRequest: 'Make HR onboarding.', plannerResponse: JSON.stringify({ ...hrDraft, components: [{ type: 'heading', text: '<script>steal()</script>' }] }) }), /raw HTML/);
  assert.throws(() => planAppBuildFromNaturalLanguage({ userRequest: 'Make HR onboarding.', plannerResponse: JSON.stringify({ ...hrDraft, execution: 'run shell command' }) }), /unsupported fields/);
  assert.throws(() => planAppBuildFromNaturalLanguage({ userRequest: 'Make HR onboarding.', plannerResponse: JSON.stringify({ ...hrDraft, components: [{ type: 'button', label: 'Deploy', action: 'deploy' }] }) }), /unsupported/);
});
