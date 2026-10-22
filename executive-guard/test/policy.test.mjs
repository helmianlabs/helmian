import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, evaluatePolicy, validatePolicy, PolicyError } from '../src/policy.mjs';
import { normalizeAction, actionHash, ActionError } from '../src/action.mjs';
import { action } from '../test-support/helpers.mjs';

const decide = (overrides) => evaluatePolicy(normalizeAction(action(overrides)));

test('a clean prompt is allowed', () => {
  assert.equal(decide({}).verdict, 'allow');
});

test('a prompt carrying a secret is denied', () => {
  for (const signal of ['secret:api_key', 'secret:private_key', 'secret:credit_card', 'secret:bearer_token', 'secret:secret_assignment']) {
    const result = decide({ riskSignals: [signal] });
    assert.equal(result.verdict, 'deny', signal);
    assert.equal(result.ruleId, 'secrets-never-leave');
  }
});

test('a secret wins over personal info in the same prompt', () => {
  assert.equal(decide({ riskSignals: ['pii:email', 'secret:api_key'] }).verdict, 'deny');
});

test('an SSN or contact details need approval', () => {
  assert.equal(decide({ riskSignals: ['pii:ssn'] }).verdict, 'ask');
  assert.equal(decide({ riskSignals: ['pii:email'] }).verdict, 'ask');
});

test('destructive intent needs a human', () => {
  const result = decide({ riskSignals: ['destructive-intent'] });
  assert.equal(result.verdict, 'ask');
  assert.equal(result.ruleId, 'destructive-needs-approval');
  assert.equal(decide({ kind: 'code.reveal', riskSignals: ['destructive-command'] }).verdict, 'ask');
});

test('an unknown signal on a prompt fails closed', () => {
  const result = decide({ riskSignals: ['something-new'] });
  assert.equal(result.verdict, 'deny');
  assert.equal(result.ruleId, 'default');
});

test('agent tool calls with no rule fail closed', () => {
  assert.equal(decide({ kind: 'agent.tool' }).verdict, 'deny');
});

test('network requests: deny-listed hosts are denied, plain hosts allowed', () => {
  assert.equal(decide({ kind: 'network.request', target: 'evil.example', riskSignals: ['host:denylisted'] }).verdict, 'deny');
  assert.equal(decide({ kind: 'network.request', target: 'api.example.com' }).verdict, 'allow');
});

test('validatePolicy refuses broken policies', () => {
  assert.throws(() => validatePolicy({ defaultVerdict: 'maybe', rules: [] }), PolicyError);
  assert.throws(() => validatePolicy({ defaultVerdict: 'deny', rules: [{ id: 'a', when: {}, verdict: 'allow' }, { id: 'a', when: {}, verdict: 'deny' }] }), PolicyError);
  assert.doesNotThrow(() => validatePolicy(DEFAULT_POLICY));
});

test('normalizeAction rejects unknown kinds, bad hashes and oversize summaries', () => {
  assert.throws(() => normalizeAction(action({ kind: 'launch.missiles' })), ActionError);
  assert.throws(() => normalizeAction(action({ contentHash: 'abc' })), ActionError);
  assert.throws(() => normalizeAction(action({ summary: 'x'.repeat(501) })), ActionError);
  assert.throws(() => normalizeAction(action({ site: 'https://chatgpt.com/' })), ActionError);
  assert.throws(() => normalizeAction(action({ riskSignals: ['BAD SIGNAL!'] })), ActionError);
});

test('normalizeAction refuses a summary that still carries a secret', () => {
  assert.throws(
    () => normalizeAction(action({ summary: 'my key is sk-abcdefghijklmnopqrstuv' })),
    (error) => error instanceof ActionError && error.code === 'unredacted-content',
  );
});

test('normalizeAction redacts personal info out of the stored summary', () => {
  const normalized = normalizeAction(action({ summary: 'mail troy@example.org' }));
  assert.equal(normalized.summary, 'mail [REDACTED:email]');
});

test('the action hash ignores the summary and signal order but not the content', () => {
  const a = normalizeAction(action({ riskSignals: ['pii:email', 'pii:ssn'], summary: 'one' }));
  const b = normalizeAction(action({ riskSignals: ['pii:ssn', 'pii:email'], summary: 'two' }));
  const c = normalizeAction(action({ riskSignals: ['pii:ssn', 'pii:email'], contentHash: 'f'.repeat(64) }));
  assert.equal(actionHash(a), actionHash(b));
  assert.notEqual(actionHash(a), actionHash(c));
});
