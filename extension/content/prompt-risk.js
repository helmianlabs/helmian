// Detects destructive intent in text being submitted to an AI chat composer.
//
// This is intentionally separate from the command kernel. The kernel recognizes
// executable syntax in code blocks; this lane recognizes a small, explicit set
// of natural-language requests to erase an entire machine, drive or data set.
// Keeping the two separate prevents safety advice such as "never run rm -rf"
// from becoming a false block while still stopping a request before it is sent.

(function attachHelmionPromptRisk(root) {
  'use strict';

  var PROTECTIVE_CONTEXT = [
    /^\s*(?:how|what)\s+(?:can|could|should|do)\s+(?:i|we|you)\s+(?:prevent|avoid|stop|recover|restore|undo)\b/i,
    /^\s*(?:explain|describe)\s+(?:why|how)\b.{0,80}\b(?:dangerous|unsafe|prevent|recover|restore)\b/i,
    /^\s*(?:do not|don't|never)\b/i,
    /^\s*is\s+it\s+safe\b/i,
  ];

  var WHOLE_DEVICE_OR_DATA = [
    /\b(?:permanently\s+)?(?:delete|erase|wipe|destroy|purge)\b.{0,90}\b(?:all|every|entire|whole)\b.{0,60}\b(?:files?|data|computer|machine|device|drive|disk|system)\b/i,
    /\b(?:all|every|entire|whole)\b.{0,60}\b(?:files?|data)\b.{0,90}\b(?:permanently\s+)?(?:delete|erase|wipe|destroy|purge)\b/i,
    /\b(?:wipe|erase|destroy|format)\b.{0,60}\b(?:computer|machine|device|drive|disk|system)\b.{0,60}\b(?:completely|entirely|permanently|unrecoverable)\b/i,
    /\b(?:factory[- ]reset|format)\b.{0,60}\b(?:every|all|entire|whole)?\s*(?:drive|disk|computer|machine|device|system)\b/i,
  ];

  var DIRECT_COMMAND = [
    /(?:^|[;&|`(\s])rm\s+[^;&|]*(?:-[A-Za-z]*[rRf][A-Za-z]*|--(?:recursive|force|dir))\b/i,
    /\bRemove-Item\b[^;&|]*\s-(?:Rec|Forc)[a-z]*\b/i,
    /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i,
    /\b(?:mkfs(?:\.|\s)|dd\b[^;&|]*\bof=)\b/i,
  ];

  function scan(text) {
    var source = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!source) return { blocked: false, hits: [], message: '' };

    if (PROTECTIVE_CONTEXT.some(function matches(pattern) { return pattern.test(source); })) {
      return { blocked: false, hits: [], message: '' };
    }

    var hits = [];
    if (WHOLE_DEVICE_OR_DATA.some(function matches(pattern) { return pattern.test(source); })) {
      hits.push('request to erase an entire device or data set');
    }
    if (DIRECT_COMMAND.some(function matches(pattern) { return pattern.test(source); })) {
      hits.push('destructive command in request');
    }

    return {
      blocked: hits.length > 0,
      hits: hits,
      message: hits.length > 0
        ? 'This request could permanently erase files, data, or a device.'
        : '',
    };
  }

  root.HelmionPromptRisk = { scan: scan };
}(typeof globalThis !== 'undefined' ? globalThis : this));
