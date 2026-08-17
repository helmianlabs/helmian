import { createHash } from 'node:crypto';
import { normalizeAppBuildRequest } from './app-build-intent.mjs';

export const CORA_APP_BUILD_NATURAL_LANGUAGE_PLAN_FORMAT = 'cora.app-build-natural-language-plan.v1';

function text(value, name, max) {
  if (typeof value !== 'string') throw new Error(`${name} is required`);
  const result = value.trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function rejectExecutableMarkup(value) {
  const serialized = JSON.stringify(value);
  if (/<\/?[a-z!][^>]*>/iu.test(serialized) || /\b(?:javascript\s*:|<script|function\s*\(|=>|process\.|child_process|eval\s*\()/iu.test(serialized)) {
    throw new Error('planner response contains raw HTML or executable JavaScript');
  }
}

/**
 * Converts only an injected, already-structured planner response into Cora's
 * existing bounded declarative request. This module intentionally has no model
 * client, repository, filesystem, provider, or deployment dependency.
 */
export function planAppBuildFromNaturalLanguage({ userRequest, plannerResponse } = {}) {
  const prompt = text(userRequest, 'user request', 4000);
  const rawResponse = text(plannerResponse, 'structured planner response', 20000);
  let candidate;
  try { candidate = JSON.parse(rawResponse); } catch { throw new Error('structured planner response must be valid JSON'); }
  rejectExecutableMarkup(candidate);
  const normalized = normalizeAppBuildRequest(candidate);
  return Object.freeze({
    format: CORA_APP_BUILD_NATURAL_LANGUAGE_PLAN_FORMAT,
    valid: true,
    source: Object.freeze({ kind: 'injected-structured-planner-response', userRequestSha256: sha256(prompt), plannerResponseSha256: sha256(rawResponse) }),
    normalized,
    normalization: Object.freeze({ normalizer: 'normalizeAppBuildRequest', status: 'passed' }),
    execution: 'not_performed',
    providerInvocation: 'not_performed',
    persistence: 'not_performed',
    filesystemMutation: 'not_performed',
    publication: 'not_performed',
    deployment: 'not_performed',
  });
}
