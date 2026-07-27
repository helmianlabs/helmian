import { assertResolutionEvidence } from './governance.mjs';

export const DEFAULT_CANARIES = Object.freeze([
  'git status --porcelain',
  'git log --oneline -3',
  'npx tsc --noEmit -p tsconfig.json',
  'node --test',
  'npx jest --silent',
  'src/pages/Dispatch.tsx',
  'README.md',
  'helmion blockers',
]);

function escapedPattern(token) {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

export function deriveCandidateRule(blocker, canaries = DEFAULT_CANARIES) {
  assertResolutionEvidence(blocker);
  const mistake = `${blocker.description ?? ''} ${blocker.root_cause ?? ''}`;
  const candidates = [];

  for (const match of mistake.matchAll(/\b(git\s+[a-z-]+(?:\s+--?[a-z-]+)?)/gi)) candidates.push(match[1]);
  for (const match of mistake.matchAll(/\b([\w.-]+\.(?:ts|tsx|js|mjs|py|json|sql|ps1|sh|md))\b/gi)) candidates.push(match[1]);
  for (const match of mistake.matchAll(/(?<![\w-])(--[a-z][a-z-]{3,})/gi)) candidates.push(match[1]);
  for (const match of mistake.matchAll(/\b([a-z_]+\.[a-z_]+\([^)]{0,40}\))/gi)) candidates.push(match[1]);

  const unique = [...new Set(candidates.map((value) => value.trim()).filter((value) => value.length >= 8))]
    .sort((a, b) => b.length - a.length);

  for (const token of unique) {
    const pattern = escapedPattern(token);
    const expression = new RegExp(pattern, 'i');
    if (canaries.some((canary) => expression.test(canary))) continue;
    if (expression.test(blocker.snippet)) continue;
    return {
      pattern,
      flags: 'i',
      severity: 'flag',
      reason: blocker.lesson ?? blocker.description,
      snippet: blocker.snippet,
      citation: blocker.citation,
      from_blocker: blocker.id,
      project_slug: blocker.project_slug ?? null,
      promoted_at: blocker.resolved_at ?? new Date().toISOString(),
    };
  }
  return null;
}

export function distillResolvedBlocker(blocker, canaries = DEFAULT_CANARIES) {
  assertResolutionEvidence(blocker);
  const rule = deriveCandidateRule(blocker, canaries);
  return {
    lesson: {
      source_blocker: blocker.id,
      project_slug: blocker.project_slug ?? null,
      root_cause: blocker.root_cause,
      lesson: blocker.lesson ?? blocker.description,
      outcome: blocker.outcome,
      citation: blocker.citation,
      snippet: blocker.snippet,
      distilled_at: new Date().toISOString(),
    },
    rule,
  };
}
