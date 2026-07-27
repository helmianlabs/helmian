import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCandidateRule, distillResolvedBlocker } from '../src/core/distiller.mjs';

const blocker = {
  id: 6,
  project_slug: 'dairyforge',
  description: 'Shell invocation used --skip-verification before evidence existed',
  root_cause: 'The worker treated --skip-verification as a harmless speed flag',
  lesson: 'Verification gates cannot be skipped before proof is recorded',
  outcome: '12/12 verification tests passed after removing the bypass',
  citation: 'scripts/deploy.ps1:81',
  snippet: 'npm run verify',
  resolved_at: '2026-07-26T12:00:00Z',
};

test('distiller derives candidates from the mistake, not the remedy', () => {
  const result = distillResolvedBlocker(blocker);
  assert.match(result.rule.pattern, /skip/);
  assert.doesNotMatch(result.rule.pattern, /npm/);
  assert.equal(result.rule.severity, 'flag');
});

test('distiller refuses rules that match an ordinary-work canary', () => {
  const ordinary = {
    ...blocker,
    description: 'Worker ran git status without first opening the dashboard',
    root_cause: 'git status was incorrectly classified as destructive',
    snippet: 'Open the dashboard before inspecting state',
  };
  assert.equal(deriveCandidateRule(ordinary), null);
});
