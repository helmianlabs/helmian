// Allow / deny / ask. First matching rule wins; anything no rule matches is
// decided by `defaultVerdict`, which is 'deny' — an unknown situation fails
// closed. The default policy below is the one the extension mirrors offline
// (extension/background/local-policy.js); a test pins the two to the same
// answers so an offline browser and the server never disagree on a fixture.

export const VERDICTS = Object.freeze(['allow', 'deny', 'ask']);

export const SECRET_SIGNALS = Object.freeze([
  'secret:private_key', 'secret:api_key', 'secret:bearer_token', 'secret:secret_assignment',
  'secret:credit_card',
]);
export const PII_SIGNALS = Object.freeze(['pii:ssn', 'pii:email', 'pii:phone', 'pii:ipv4']);

export const DEFAULT_POLICY = Object.freeze({
  version: 1,
  defaultVerdict: 'deny',
  rules: [
    { id: 'secrets-never-leave', when: { kinds: ['prompt.send', 'prompt.paste'], anySignal: SECRET_SIGNALS }, verdict: 'deny',
      reason: 'A key, password, token or card number would be sent to an AI. Redact it first.' },
    { id: 'ssn-needs-approval', when: { kinds: ['prompt.send', 'prompt.paste'], anySignal: ['pii:ssn'] }, verdict: 'ask',
      reason: 'A social security number would be sent to an AI.' },
    { id: 'destructive-needs-approval', when: { kinds: ['prompt.send', 'code.reveal', 'agent.tool'], anySignal: ['destructive-intent', 'destructive-command'] }, verdict: 'ask',
      reason: 'This could permanently erase files, data or a device. A human must approve it.' },
    { id: 'personal-info-needs-approval', when: { kinds: ['prompt.send', 'prompt.paste'], anySignal: ['pii:email', 'pii:phone', 'pii:ipv4'] }, verdict: 'ask',
      reason: 'Personal contact details would be sent to an AI.' },
    { id: 'blocked-hosts', when: { kinds: ['network.request'], anySignal: ['host:denylisted'] }, verdict: 'deny',
      reason: 'This host is on the deny list.' },
    { id: 'clean-prompt', when: { kinds: ['prompt.send', 'prompt.paste', 'code.reveal'], noSignals: true }, verdict: 'allow',
      reason: 'No risk signals.' },
    { id: 'known-host', when: { kinds: ['network.request'], noSignals: true }, verdict: 'allow', reason: 'No risk signals.' },
  ],
});

export class PolicyError extends Error {}

export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new PolicyError('policy must be an object');
  if (!VERDICTS.includes(policy.defaultVerdict)) throw new PolicyError('defaultVerdict must be allow, deny or ask');
  if (!Array.isArray(policy.rules)) throw new PolicyError('rules must be an array');
  const ids = new Set();
  for (const rule of policy.rules) {
    if (!rule || typeof rule.id !== 'string' || !rule.id) throw new PolicyError('every rule needs an id');
    if (ids.has(rule.id)) throw new PolicyError(`duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    if (!VERDICTS.includes(rule.verdict)) throw new PolicyError(`rule ${rule.id} has an invalid verdict`);
    if (!rule.when || typeof rule.when !== 'object') throw new PolicyError(`rule ${rule.id} needs a when clause`);
  }
  return policy;
}

function matches(when, action) {
  if (Array.isArray(when.kinds) && !when.kinds.includes(action.kind)) return false;
  if (Array.isArray(when.sites) && !when.sites.includes(action.site)) return false;
  if (when.noSignals === true && action.riskSignals.length > 0) return false;
  if (Array.isArray(when.anySignal) && !when.anySignal.some((s) => action.riskSignals.includes(s))) return false;
  if (Array.isArray(when.allSignals) && !when.allSignals.every((s) => action.riskSignals.includes(s))) return false;
  return true;
}

export function evaluatePolicy(action, policy = DEFAULT_POLICY) {
  for (const rule of policy.rules) {
    if (matches(rule.when, action)) {
      return { verdict: rule.verdict, ruleId: rule.id, reason: rule.reason || '' };
    }
  }
  return { verdict: policy.defaultVerdict, ruleId: 'default', reason: 'No rule matched; the default applies.' };
}
