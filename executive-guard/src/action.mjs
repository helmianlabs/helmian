// The shape of an action the extension (or any client) asks Executive Guard
// about. Nothing here accepts raw page content: a client sends a short,
// already-redacted summary, the risk signals it detected, and a SHA-256 of the
// exact content so a signed decision binds to that content and nothing else.

import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.mjs';
import { redactSensitivePrompt } from '../../extension/background/redact.js';

export const ACTION_KINDS = Object.freeze([
  'prompt.send', // text about to be sent to an AI chat
  'prompt.paste', // content pasted into an AI composer
  'code.reveal', // user asks to reveal a masked destructive code block
  'network.request', // a page or tool wants to reach a host
  'agent.tool', // an agent tool call (shell, file write, deploy)
]);

export const MAX_SUMMARY_CHARS = 500;
const SIGNAL_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SITE_PATTERN = /^[a-z0-9.-]{1,253}$/;

export class ActionError extends Error {
  constructor(message, code = 'invalid-action') {
    super(message);
    this.name = 'ActionError';
    this.code = code;
  }
}

export function normalizeAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ActionError('action must be an object');
  }
  const kind = String(input.kind ?? '');
  if (!ACTION_KINDS.includes(kind)) throw new ActionError(`unknown action kind: ${kind || '(empty)'}`);

  const site = String(input.site ?? '').toLowerCase();
  if (!SITE_PATTERN.test(site)) throw new ActionError('site must be a hostname');

  const contentHash = String(input.contentHash ?? '').toLowerCase();
  if (!HASH_PATTERN.test(contentHash)) throw new ActionError('contentHash must be a sha256 hex digest');

  const rawSignals = Array.isArray(input.riskSignals) ? input.riskSignals : [];
  if (rawSignals.length > 32) throw new ActionError('too many risk signals');
  const riskSignals = [...new Set(rawSignals.map((s) => String(s).toLowerCase()))].sort();
  for (const signal of riskSignals) {
    if (!SIGNAL_PATTERN.test(signal)) throw new ActionError(`invalid risk signal: ${signal}`);
  }

  const summary = String(input.summary ?? '');
  if (summary.length > MAX_SUMMARY_CHARS) throw new ActionError(`summary is longer than ${MAX_SUMMARY_CHARS} characters`);
  // Defense in depth: the client is supposed to redact before it sends. If a
  // secret still arrives, refuse the request rather than storing it in the
  // audit trail.
  const check = redactSensitivePrompt(summary);
  const leaked = check.telemetry.redactedTypes.filter((type) => ![
    'email', 'phone', 'ipv4',
  ].includes(type));
  if (leaked.length) {
    throw new ActionError(`summary carries unredacted sensitive content (${leaked.join(', ')})`, 'unredacted-content');
  }

  const target = input.target == null ? undefined : String(input.target).toLowerCase();
  if (target !== undefined && !SITE_PATTERN.test(target)) throw new ActionError('target must be a hostname');

  return Object.freeze({ kind, site, contentHash, riskSignals, summary: check.text, ...(target ? { target } : {}) });
}

export function actionHash(action) {
  const { kind, site, contentHash, riskSignals, target } = action;
  return createHash('sha256').update(canonicalJson({ kind, site, contentHash, riskSignals, target })).digest('hex');
}
