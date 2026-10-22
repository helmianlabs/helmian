// The offline policy must give the same answer as the server's default policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, evaluatePolicy } from '../../executive-guard/src/policy.mjs';
import { normalizeAction } from '../../executive-guard/src/action.mjs';
import { evaluateLocal, LOCAL_RULES } from '../background/local-policy.js';

const KINDS = ['prompt.send', 'prompt.paste', 'code.reveal', 'network.request', 'agent.tool'];
const SIGNAL_SETS = [
  [], ['secret:api_key'], ['secret:credit_card'], ['secret:private_key'], ['secret:bearer_token'], ['secret:secret_assignment'],
  ['pii:ssn'], ['pii:email'], ['pii:phone'], ['pii:ipv4'], ['destructive-intent'], ['destructive-command'],
  ['host:denylisted'], ['pii:email', 'secret:api_key'], ['destructive-intent', 'pii:ssn'], ['unknown-signal'],
];

test('PARITY: local policy == server default policy on every kind x signal combination', () => {
  let checked = 0;
  for (const kind of KINDS) {
    for (const riskSignals of SIGNAL_SETS) {
      const action = normalizeAction({ kind, site: 'chatgpt.com', contentHash: 'a'.repeat(64), riskSignals, summary: '' });
      const server = evaluatePolicy(action, DEFAULT_POLICY);
      const local = evaluateLocal(action);
      assert.equal(local.verdict, server.verdict, `${kind} ${riskSignals.join('+')}`);
      assert.equal(local.ruleId, server.ruleId, `${kind} ${riskSignals.join('+')}`);
      checked += 1;
    }
  }
  assert.equal(checked, KINDS.length * SIGNAL_SETS.length);
});

test('PARITY: same rule ids in the same order', () => {
  assert.deepEqual(LOCAL_RULES.map((r) => r.id), DEFAULT_POLICY.rules.map((r) => r.id));
});
