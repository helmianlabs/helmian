// The offline twin of Executive Guard's default policy
// (executive-guard/src/policy.mjs DEFAULT_POLICY). Used when no Executive Guard
// server is configured or it cannot be reached. test/local-policy.test.mjs runs
// both over the same actions and fails if they ever disagree.
//
// 'ask' offline means: ask the person at the keyboard. It is not a signed
// approval and is never reported as one.

const SECRET_SIGNALS = ['secret:private_key', 'secret:api_key', 'secret:bearer_token', 'secret:secret_assignment', 'secret:credit_card'];

export const LOCAL_RULES = Object.freeze([
  { id: 'secrets-never-leave', kinds: ['prompt.send', 'prompt.paste'], anySignal: SECRET_SIGNALS, verdict: 'deny',
    reason: 'A key, password, token or card number would be sent to an AI. Redact it first.' },
  { id: 'ssn-needs-approval', kinds: ['prompt.send', 'prompt.paste'], anySignal: ['pii:ssn'], verdict: 'ask',
    reason: 'A social security number would be sent to an AI.' },
  { id: 'destructive-needs-approval', kinds: ['prompt.send', 'code.reveal', 'agent.tool'], anySignal: ['destructive-intent', 'destructive-command'], verdict: 'ask',
    reason: 'This could permanently erase files, data or a device. A human must approve it.' },
  { id: 'personal-info-needs-approval', kinds: ['prompt.send', 'prompt.paste'], anySignal: ['pii:email', 'pii:phone', 'pii:ipv4'], verdict: 'ask',
    reason: 'Personal contact details would be sent to an AI.' },
  { id: 'blocked-hosts', kinds: ['network.request'], anySignal: ['host:denylisted'], verdict: 'deny', reason: 'This host is on the deny list.' },
  { id: 'clean-prompt', kinds: ['prompt.send', 'prompt.paste', 'code.reveal'], noSignals: true, verdict: 'allow', reason: 'No risk signals.' },
  { id: 'known-host', kinds: ['network.request'], noSignals: true, verdict: 'allow', reason: 'No risk signals.' },
]);

export function evaluateLocal(action) {
  const signals = action.riskSignals || [];
  for (const rule of LOCAL_RULES) {
    if (!rule.kinds.includes(action.kind)) continue;
    if (rule.noSignals && signals.length > 0) continue;
    if (rule.anySignal && !rule.anySignal.some((s) => signals.includes(s))) continue;
    return { verdict: rule.verdict, ruleId: rule.id, reason: rule.reason };
  }
  return { verdict: 'deny', ruleId: 'default', reason: 'No rule matched; the default applies.' };
}
