// FLAGS: cross-AI alerts about the REPLY, in three kinds.
//
//   evasion       the AI refused, deflected or buried the answer in hedges.
//                 Two sub-rules: a refusal/deflection phrase, or a passage so
//                 thick with hedges (three or more distinct ones) that it says
//                 nothing checkable. Advisory: never blocks, never masks.
//   privacy-leak  the reply shows a key, password, token, card number or
//                 personal details (HelmionSanitize decides what counts).
//   harmful-code  a code block carries a malicious pattern: reverse shells,
//                 download-and-execute, credential theft, keyloggers, miners,
//                 turning off security tools, fork bombs, persistence.
//                 Destructive commands (rm -rf, DROP TABLE) are NOT repeated
//                 here; the red code lane already owns them.
//
// Prose is read for evasion and leaks; code is read for leaks and harmful
// patterns. The same separation the rest of the extension keeps: a sentence
// warning against a reverse shell is not a reverse shell.
//
// Every flag carries a REDACTED excerpt only. A flag about a leaked key must not
// become the second place that key is stored.
//
// Plain script; publishes HelmionFlags. Depends on HelmionSanitize.

(function attachHelmionFlags(root) {
  'use strict';

  var MAX_EXCERPT = 240;

  var REFUSALS = [
    { id: 'refusal', pattern: /\bI(?:'m| am)\s+(?:not\s+(?:able|allowed|permitted)|unable)\s+to\s+(?:help|assist|provide|share|discuss|answer|do\s+that|comply)\b/i },
    { id: 'refusal', pattern: /\bI\s+(?:can(?:no|')t|cannot|won't|will\s+not)\s+(?:help|assist|provide|share|discuss|answer|comply|do\s+that|fulfil)/i },
    { id: 'refusal', pattern: /\bI(?:'m| am)\s+sorry,?\s+but\s+I\s+(?:can(?:no|')t|cannot|won't)\b/i },
    { id: 'as-an-ai', pattern: /\bAs\s+an\s+AI(?:\s+(?:language\s+)?model)?\b,?\s+I\s+(?:don't|do\s+not|can(?:no|')t|cannot|am\s+not)\b/i },
    { id: 'deflection', pattern: /\b(?:you\s+(?:should|may\s+want\s+to|might\s+want\s+to)\s+)?(?:consult|contact|speak\s+(?:with|to)|reach\s+out\s+to)\s+(?:a|an|your)\s+(?:qualified\s+|licensed\s+)?(?:professional|expert|lawyer|attorney|doctor|specialist|administrator)\s+(?:for|instead|rather)\b/i },
    { id: 'deflection', pattern: /\b(?:it's|it\s+is)\s+(?:not\s+(?:appropriate|possible)\s+for\s+me|beyond\s+(?:my|the)\s+scope)\b/i },
  ];

  var HEDGES = [
    /\bI\s+(?:think|believe|suspect|guess)\b/i,
    /\b(?:probably|possibly|perhaps|maybe|presumably|arguably)\b/i,
    /\bit\s+(?:may|might|could)\s+(?:be|depend)\b/i,
    /\bit\s+depends\b/i,
    /\b(?:not\s+(?:entirely|completely|100%)\s+(?:sure|certain))\b/i,
    /\b(?:generally|typically|usually)\s+speaking\b/i,
    /\bto\s+(?:some|a\s+certain)\s+(?:extent|degree)\b/i,
    /\b(?:in\s+some\s+cases|under\s+certain\s+circumstances)\b/i,
    /\bmay\s+or\s+may\s+not\b/i,
  ];
  var HEDGE_THRESHOLD = 3;

  var PROTECTIVE = /^\s*(?:never|do\s+not|don't|avoid|warning|caution)\b/i;

  var HARMFUL = [
    { id: 'reverse-shell', label: 'reverse shell', pattern: /(?:\/dev\/tcp\/[\w.-]+\/\d+|\bnc(?:at)?\b[^\n]*\s-(?:e|c)\s+\/?(?:bin\/)?(?:ba)?sh\b|\bsocket\.socket\([^\n]*\)[\s\S]{0,400}?\b(?:subprocess|os\.dup2|pty\.spawn)|New-Object\s+System\.Net\.Sockets\.TCPClient[\s\S]{0,300}?(?:iex|Invoke-Expression))/i },
    { id: 'download-execute', label: 'downloads and runs remote code', pattern: /(?:\b(?:curl|wget)\b[^\n|]*https?:\/\/(?:\d{1,3}\.){3}\d{1,3}[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\bIEX\s*\(?\s*\(?\s*New-Object\s+Net\.WebClient\)?\.DownloadString|Invoke-Expression\s*\(?\s*\(?\s*(?:New-Object\s+Net\.WebClient|Invoke-WebRequest|iwr)\b|\bpowershell(?:\.exe)?\b[^\n]*\s-(?:e|enc|encodedcommand)\s+[A-Za-z0-9+/=]{20,}|\bbase64\s+(?:-d|--decode)\b[^\n]*\|\s*(?:ba|z)?sh\b)/i },
    { id: 'credential-theft', label: 'reads stored credentials and sends them out', pattern: /(?:(?:\.ssh\/id_(?:rsa|ed25519|ecdsa)|\/etc\/shadow|Login\s+Data|Cookies|\.aws\/credentials|wallet\.dat|keychain)[\s\S]{0,600}?(?:requests\.post|fetch\(|curl\s+[^\n]*-(?:d|F|T)|urllib|discord(?:app)?\.com\/api\/webhooks|smtplib|socket\.send)|(?:requests\.post|curl\s+[^\n]*-(?:d|F|T))[\s\S]{0,600}?(?:\.ssh\/id_(?:rsa|ed25519)|\/etc\/shadow|Login\s+Data|\.aws\/credentials|wallet\.dat))/i },
    { id: 'keylogger', label: 'keylogger', pattern: /(?:pynput\.keyboard[\s\S]{0,400}?Listener|keyboard\.on_press|GetAsyncKeyState|SetWindowsHookEx(?:A|W)?\s*\(\s*(?:WH_KEYBOARD_LL|13)\b)/i },
    { id: 'crypto-miner', label: 'crypto miner', pattern: /(?:\bxmrig\b|stratum\+(?:tcp|ssl):\/\/|\bminerd\b|coinhive)/i },
    { id: 'disable-security', label: 'turns off security protections', pattern: /(?:Set-MpPreference\s+[^\n]*-Disable(?:RealtimeMonitoring|IOAVProtection|BehaviorMonitoring)\s+\$?true|\bsetenforce\s+0\b|\bufw\s+disable\b|\bsystemctl\s+(?:stop|disable)\s+(?:firewalld|apparmor|auditd)\b|\bcsrutil\s+disable\b|\bnetsh\s+advfirewall\s+set\s+\w+\s+state\s+off\b|\bspctl\s+--master-disable\b)/i },
    { id: 'fork-bomb', label: 'fork bomb', pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:|%0\|%0/ },
    { id: 'persistence', label: 'hidden persistence that fetches remote code', pattern: /(?:@reboot[^\n]*\b(?:curl|wget|nc)\b|\breg(?:\.exe)?\s+add\s+[^\n]*\\CurrentVersion\\Run\b[^\n]*(?:http|powershell)|schtasks\s+\/create[^\n]*(?:http|powershell\s+-(?:e|enc)))/i },
    { id: 'log-wipe', label: 'wipes logs to hide activity', pattern: /(?:\bwevtutil\s+cl\b|Clear-EventLog\b|>\s*\/var\/log\/(?:auth|secure|wtmp|btmp)|\bhistory\s+-c\b[^\n]*&&[^\n]*unset\s+HISTFILE|\bshred\b[^\n]*\/var\/log)/i },
  ];

  function excerpt(text, index, length) {
    var source = String(text);
    var start = Math.max(0, (index || 0) - 60);
    var end = Math.min(source.length, start + MAX_EXCERPT);
    var slice = source.slice(start, end).replace(/\s+/g, ' ').trim();
    var safe = root.HelmionSanitize ? root.HelmionSanitize.scan(slice).redacted : slice;
    return (start > 0 ? '…' : '') + safe + (end < source.length ? '…' : '');
  }

  function privacyFlags(text, lane) {
    if (!root.HelmionSanitize) return [];
    var result = root.HelmionSanitize.scan(text);
    // An IP address in a reply is almost always an example or a server the
    // user asked about. It is redacted from excerpts but is not a leak flag.
    var signals = result.signals.filter(function notIp(s) { return s !== 'pii:ipv4'; });
    if (!signals.length) return [];
    return [{
      kind: 'privacy-leak',
      severity: result.hasSecrets ? 'high' : 'medium',
      rule: signals.join(','),
      label: 'The reply shows ' + root.HelmionSanitize.describe(result),
      lane: lane,
      signals: signals,
      excerpt: result.redacted.replace(/\s+/g, ' ').trim().slice(0, MAX_EXCERPT),
    }];
  }

  function detectProse(input) {
    var text = String(input == null ? '' : input);
    if (!text.trim()) return [];
    var flags = [];

    for (var i = 0; i < REFUSALS.length; i += 1) {
      var match = REFUSALS[i].pattern.exec(text);
      if (match) {
        flags.push({
          kind: 'evasion',
          severity: 'notice',
          rule: REFUSALS[i].id,
          label: REFUSALS[i].id === 'deflection'
            ? 'The AI sent you elsewhere instead of answering'
            : 'The AI declined or avoided the question',
          lane: 'prose',
          excerpt: excerpt(text, match.index, match[0].length),
        });
        break;
      }
    }

    if (!flags.length && !PROTECTIVE.test(text)) {
      var hits = 0;
      var first = -1;
      for (var h = 0; h < HEDGES.length; h += 1) {
        var hm = HEDGES[h].exec(text);
        if (hm) { hits += 1; if (first < 0 || hm.index < first) first = hm.index; }
      }
      if (hits >= HEDGE_THRESHOLD) {
        flags.push({
          kind: 'evasion',
          severity: 'notice',
          rule: 'hedging',
          label: 'The answer is buried in hedges (' + hits + ' different ones)',
          lane: 'prose',
          excerpt: excerpt(text, first, 0),
        });
      }
    }

    return flags.concat(privacyFlags(text, 'prose'));
  }

  function detectCode(input) {
    var text = String(input == null ? '' : input);
    if (!text.trim()) return [];
    var flags = [];
    for (var i = 0; i < HARMFUL.length; i += 1) {
      var match = HARMFUL[i].pattern.exec(text);
      if (match) {
        flags.push({
          kind: 'harmful-code',
          severity: 'high',
          rule: HARMFUL[i].id,
          label: 'Suggested code looks malicious: ' + HARMFUL[i].label,
          lane: 'code',
          excerpt: excerpt(text, match.index, match[0].length),
        });
      }
    }
    return flags.concat(privacyFlags(text, 'code'));
  }

  // Stable per page: the same flag on the same passage is shown and reported once.
  function fingerprint(flag, site) {
    var seed = [flag.kind, flag.rule, site || '', flag.excerpt].join('|');
    var hash = 5381;
    for (var i = 0; i < seed.length; i += 1) hash = ((hash * 33) ^ seed.charCodeAt(i)) >>> 0;
    return 'flag-' + hash.toString(36);
  }

  root.HelmionFlags = {
    detectProse: detectProse,
    detectCode: detectCode,
    fingerprint: fingerprint,
    KINDS: ['evasion', 'privacy-leak', 'harmful-code'],
    HARMFUL_RULES: HARMFUL.map(function id(rule) { return rule.id; }),
  };
}(typeof globalThis !== 'undefined' ? globalThis : this));
