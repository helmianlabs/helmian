// Finds secrets and personal information in text that is about to reach an AI,
// and produces a redacted copy.
//
// It is the content-script twin of background/redact.js (which a content script
// cannot import, because content scripts are not modules). The type names are
// the same and test/sanitize.test.mjs runs both over the same fixtures so the
// two never drift apart. Differences, all deliberate and all in the safe
// direction for a send-time check:
//
//   - credit card numbers must pass the Luhn check, so an order number or a
//     long id does not stop somebody's message;
//   - obvious placeholders (sk-xxxx, YOUR_API_KEY, example.com addresses,
//     555 phone numbers) are left alone;
//   - every finding is classed as 'secret' (never send) or 'pii' (ask first).
//
// No network, no storage, no model. Plain script; publishes HelmionSanitize.

(function attachHelmionSanitize(root) {
  'use strict';

  var RULES = [
    { type: 'private_key', category: 'secret', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
    { type: 'bearer_token', category: 'secret', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g },
    { type: 'api_key', category: 'secret', pattern: /\b(?:sk-ant-[A-Za-z0-9_-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|(?:sk|rk|pk)_live_[0-9A-Za-z]{16,}|glpat-[0-9A-Za-z_-]{20}|xai-[A-Za-z0-9]{20,})\b/g },
    { type: 'secret_assignment', category: 'secret', pattern: /((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|pwd|passcode|secret|token)\s*[:=]\s*)(["']?)([^\s,;"']{4,})\2/gi, keepPrefix: true },
    { type: 'email', category: 'pii', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
    { type: 'ssn', category: 'pii', pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
    { type: 'credit_card', category: 'secret', pattern: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g, luhn: true },
    { type: 'phone', category: 'pii', pattern: /(?<![\d\w])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\d\w])/g },
    { type: 'ipv4', category: 'pii', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  ];

  var PLACEHOLDER = /(?:^<|x{4,}|\*{4,}|your[_ -]?(?:api[_ -]?)?(?:key|token|secret|password)|<[^>]*>|\.\.\.|example|placeholder|changeme|redacted|dummy|sample)/i;
  var PRIVATE_IP = /^(?:127\.|0\.|255\.)/;

  function luhn(digits) {
    var sum = 0;
    var double = false;
    for (var i = digits.length - 1; i >= 0; i -= 1) {
      var d = digits.charCodeAt(i) - 48;
      if (double) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      double = !double;
    }
    return sum % 10 === 0;
  }

  function isPlaceholder(rule, value) {
    if (rule.type === 'private_key') return false;
    if (PLACEHOLDER.test(value)) return true;
    if (rule.type === 'email' && /@(?:example\.(?:com|org|net)|test\.com|domain\.com)$/i.test(value)) return true;
    if (rule.type === 'phone' && /\(?555\)?[ .-]\d{3}/.test(value)) return true;
    if (rule.type === 'ipv4' && PRIVATE_IP.test(value)) return true;
    if (rule.type === 'ipv4' && /^\d+\.\d+\.\d+\.\d+$/.test(value) && /^(?:\d\.){3}\d$/.test(value)) return true; // 1.2.3.4-style versions
    if (rule.type === 'credit_card') {
      var digits = value.replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19) return true;
      if (/^(\d)\1+$/.test(digits)) return true;
      if (!luhn(digits)) return true;
    }
    return false;
  }

  function scan(input) {
    var text = String(input == null ? '' : input);
    var findings = [];
    var redacted = text;

    for (var r = 0; r < RULES.length; r += 1) {
      var rule = RULES[r];
      rule.pattern.lastIndex = 0;
      redacted = redacted.replace(rule.pattern, function replace(match) {
        var args = arguments;
        var value = rule.keepPrefix ? args[3] : match;
        if (rule.keepPrefix && /^\[REDACTED:/.test(value)) return match;
        if (isPlaceholder(rule, value)) return match;
        findings.push({ type: rule.type, category: rule.category });
        if (rule.keepPrefix) return args[1] + args[2] + '[REDACTED:' + rule.type + ']' + args[2];
        return '[REDACTED:' + rule.type + ']';
      });
    }

    var counts = {};
    var signals = [];
    for (var i = 0; i < findings.length; i += 1) {
      var f = findings[i];
      counts[f.type] = (counts[f.type] || 0) + 1;
      var signal = (f.category === 'secret' ? 'secret:' : 'pii:') + f.type;
      if (signals.indexOf(signal) === -1) signals.push(signal);
    }
    signals.sort();

    return {
      found: findings.length > 0,
      hasSecrets: findings.some(function s(f) { return f.category === 'secret'; }),
      hasPii: findings.some(function p(f) { return f.category === 'pii'; }),
      count: findings.length,
      counts: counts,
      signals: signals,
      redacted: redacted,
    };
  }

  function describe(result) {
    var names = {
      private_key: 'a private key', bearer_token: 'a bearer token', api_key: 'an API key',
      secret_assignment: 'a password or secret', credit_card: 'a card number', email: 'an email address',
      ssn: 'a social security number', phone: 'a phone number', ipv4: 'an IP address',
    };
    return Object.keys(result.counts).map(function n(type) {
      var c = result.counts[type];
      return c > 1 ? c + ' × ' + (names[type] || type).replace(/^an? /, '') : (names[type] || type);
    }).join(', ');
  }

  root.HelmionSanitize = {
    scan: scan,
    describe: describe,
    TYPES: RULES.map(function t(rule) { return rule.type; }),
  };
}(typeof globalThis !== 'undefined' ? globalThis : this));
