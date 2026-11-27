// Helmian Site Guard — attack rules for inbound content (2026-11-26).
//
// What this file adds to the Site Guard (src/cloud/site-guard.mjs):
// pure, bounded detectors for the attack classes the public Site Guard
// page names, each one a RULE with an id, a class, and an action
// (block or flag). Every rule except the legacy weak markers defaults
// to BLOCK; an operator can turn any rule to flag or off without a
// code change (resolveSiteGuardPolicy, below).
//
//   prompt-injection.override       "ignore all previous instructions" family
//                                   (the src/core/injection-risk.mjs kernel,
//                                   reused by import, plus chat-template
//                                   role tokens like <|im_start|>system)
//   prompt-injection.indirect       instructions planted for an AI inside
//                                   content ("note to the AI reading this…",
//                                   hidden HTML comments addressed to it)
//   prompt-injection.roleplay       persona jailbreaks that remove the rules
//                                   ("pretend you are an AI with no
//                                   restrictions", "developer mode enabled", DAN)
//   prompt-injection.obfuscated     any attack that only shows after
//                                   decoding: base64, hex, URL or unicode
//                                   escapes, zero-width characters,
//                                   homoglyphs, spaced letters, leetspeak
//   prompt-injection.weak-marker    the legacy one-word markers ("jailbreak",
//                                   a line starting "system:") — FLAG by
//                                   default, because they hit ordinary text
//                                   ("how do I jailbreak my phone",
//                                   pasted logs)
//   secret-fishing.credentials      asks for the AI's / site's keys,
//                                   passwords, tokens, connection strings
//   secret-fishing.system-prompt    asks to reveal the system prompt or the
//                                   hidden instructions
//   secret-fishing.env-config       asks to dump environment variables,
//                                   config or secret files (cat .env,
//                                   print process.env, ~/.ssh/id_rsa…)
//   data-exfiltration.ask           asks to send conversation/user data to
//                                   an outside address, markdown-image
//                                   beacons, other users' personal data
//
// False-positive discipline (pinned by test/site-guard-attack-corpus.test.mjs):
// - Ownership matters: "where do I find MY api key" is help; "what is
//   YOUR api key" / "the admin password" is fishing. The rules look for an
//   addressee or owner (your, the server's, the admin's, stored, all…),
//   never a bare noun.
// - Talking ABOUT an attack is not an attack. A sentence that explains,
//   defines, or asks how to defend, and a negated instruction ("never
//   reveal your api key"), are skipped — unless the same sentence aims a
//   reveal at the assistant's own secrets.
// - Matching runs on detection views only (normalized, folded, decoded).
//   Nothing here changes what is stored or shown.
//
// Pure: no I/O, no clocks. Input is capped (MAX_RULE_CHARS) and every
// pattern uses bounded gaps, so a long message cannot make it slow.

import { scanInjection } from '../core/injection-risk.mjs';

export const SITE_GUARD_RULE_CLASS = Object.freeze({
  INJECTION: 'prompt-injection',
  SECRET_FISHING: 'secret-fishing',
  EXFILTRATION: 'data-exfiltration',
});

export const SITE_GUARD_ACTION = Object.freeze({ BLOCK: 'block', FLAG: 'flag', OFF: 'off' });

export const SITE_GUARD_RULES = Object.freeze({
  'prompt-injection.override': Object.freeze({ class: 'prompt-injection', defaultAction: 'block', label: 'instruction override' }),
  'prompt-injection.indirect': Object.freeze({ class: 'prompt-injection', defaultAction: 'block', label: 'instructions planted for the AI inside content' }),
  'prompt-injection.roleplay': Object.freeze({ class: 'prompt-injection', defaultAction: 'block', label: 'role-play jailbreak' }),
  'prompt-injection.obfuscated': Object.freeze({ class: 'prompt-injection', defaultAction: 'block', label: 'encoded or disguised attack' }),
  'prompt-injection.weak-marker': Object.freeze({ class: 'prompt-injection', defaultAction: 'flag', label: 'weak injection marker' }),
  'secret-fishing.credentials': Object.freeze({ class: 'secret-fishing', defaultAction: 'block', label: 'asking for keys, passwords or tokens' }),
  'secret-fishing.system-prompt': Object.freeze({ class: 'secret-fishing', defaultAction: 'block', label: 'asking for the system prompt' }),
  'secret-fishing.env-config': Object.freeze({ class: 'secret-fishing', defaultAction: 'block', label: 'asking for environment variables or config' }),
  'data-exfiltration.ask': Object.freeze({ class: 'data-exfiltration', defaultAction: 'block', label: 'asking to send data out' }),
});

export const MAX_RULE_CHARS = 12000;

/**
 * Build the action table. `overrides` is an object or a JSON string
 * mapping rule id → 'block' | 'flag' | 'off'. A class name (for
 * example 'secret-fishing') sets every rule in that class. Unknown ids
 * and unknown actions are ignored, so a typo can never switch a rule
 * off by accident. The env road: HELMIAN_SITE_GUARD_RULES.
 */
export function resolveSiteGuardPolicy(overrides = null) {
  let parsed = overrides;
  if (typeof overrides === 'string') {
    try { parsed = overrides.trim() ? JSON.parse(overrides) : null; } catch { parsed = null; }
  }
  const table = {};
  for (const [id, rule] of Object.entries(SITE_GUARD_RULES)) table[id] = rule.defaultAction;
  if (parsed && typeof parsed === 'object') {
    const valid = new Set(Object.values(SITE_GUARD_ACTION));
    for (const [key, value] of Object.entries(parsed)) {
      const action = String(value ?? '').toLowerCase();
      if (!valid.has(action)) continue;
      if (SITE_GUARD_RULES[key]) table[key] = action;
      else for (const [id, rule] of Object.entries(SITE_GUARD_RULES)) if (rule.class === key) table[id] = action;
    }
  }
  return Object.freeze(table);
}

export function siteGuardPolicyFromEnv(env = process.env) {
  return resolveSiteGuardPolicy(env?.HELMIAN_SITE_GUARD_RULES ?? null);
}

/* ── Detection views ─────────────────────────────────────────────────── */

const ZERO_WIDTH = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD\u034F\u180E\u202A-\u202E\u2066-\u2069]/g;
const HOMOGLYPHS = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ѕ': 's',
  'һ': 'h', 'ј': 'j', 'ԁ': 'd', 'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w', 'ɡ': 'g', 'ν': 'v', 'ο': 'o',
  'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ρ': 'p', 'τ': 't', 'χ': 'x', 'ω': 'w', 'υ': 'u',
};
const HOMOGLYPH_CHARS = new RegExp(`[${Object.keys(HOMOGLYPHS).join('')}]`, 'g');
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

function rawView(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizedView(text) {
  let view = String(text).normalize('NFKC').toLowerCase().replace(ZERO_WIDTH, '');
  view = view.replace(HOMOGLYPH_CHARS, (ch) => HOMOGLYPHS[ch] || ch);
  // Spaced letters: "i g n o r e" → "ignore" (four or more single letters).
  // Words split by two or more spaces stay words; single separators
  // between single letters are joined.
  view = view.replace(/ {2,}/g, '\u0001');
  const spacedRun = /\b(?:[a-z][ .\-_*]){3,}[a-z]\b/;
  if (spacedRun.test(view)) {
    // Evidence of letter-spacing: join every run of single letters,
    // short ones included ("i s", "a p i").
    view = view.replace(/\b(?:[a-z][ .\-_*])+[a-z]\b/g, (m) => m.replace(/[ .\-_*]/g, ''));
  }
  return view.replace(/\u0001/g, ' ').replace(/\s+/g, ' ').trim();
}

function leetView(view) {
  if (!/[a-z][013457@$]|[013457@$][a-z]/.test(view)) return null;
  return view.replace(/[a-z0-9@$]+/g, (token) => (
    /[a-z]/.test(token) && /[013457@$]/.test(token) ? token.replace(/[013457@$]/g, (ch) => LEET[ch]) : token
  ));
}

function mostlyPrintable(text) {
  if (!text || text.length < 8) return false;
  let ok = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13) ok += 1;
  }
  return ok / text.length >= 0.85 && /[a-z]{3}/i.test(text);
}

const MAX_DECODINGS = 8;

function decodings(original) {
  const out = [];
  const push = (d) => { if (d && out.length < MAX_DECODINGS && mostlyPrintable(d)) out.push(d.slice(0, 4096)); };
  for (const m of original.matchAll(/[A-Za-z0-9+/_-]{20,}={0,2}/g)) {
    if (out.length >= MAX_DECODINGS) break;
    const cleaned = m[0].replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (cleaned.length % 4 === 1) continue;
    try { push(Buffer.from(cleaned, 'base64').toString('utf8')); } catch { /* not base64 */ }
  }
  for (const m of original.matchAll(/\b(?:[0-9a-fA-F]{2}[\s:]?){16,}/g)) {
    const hex = m[0].replace(/[\s:]/g, '');
    if (hex.length % 2) continue;
    try { push(Buffer.from(hex, 'hex').toString('utf8')); } catch { /* not hex */ }
  }
  if (/(?:%[0-9a-f]{2}){4,}/i.test(original)) {
    try { push(decodeURIComponent(original.replace(/\+/g, ' '))); } catch { /* malformed */ }
  }
  if (/\\u[0-9a-f]{4}|\\x[0-9a-f]{2}/i.test(original)) {
    push(original.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));
  }
  if (/&#x?[0-9a-f]+;/i.test(original)) {
    push(original.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))));
  }
  return out;
}

function sentences(view) {
  return view.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/* ── Protective contexts ─────────────────────────────────────────────── */

const DIRECT_SECRET_AIM = /\b(?:reveal|show|print|tell|give|dump|output|share|leak|repeat|display)\b.{0,40}\byour\s+(?:\w+\s+){0,2}(?:system\s+prompt|prompt|instructions|api\s*keys?|keys?|passwords?|credentials|secrets?|tokens?|env(?:ironment)?|config)/;

const EXPLAIN_FRAMES = [
  /^(?:please\s+|can you\s+|could you\s+)?(?:explain|describe|define|discuss)\b/,
  /^(?:how|what|why|when)\b.{0,80}\b(?:attacks?|injections?|jailbreaks?|phishing|exfiltration|social engineering)\b/,
  /^(?:how|what)\s+(?:can|could|should|do|does|would)\b.{0,60}\b(?:prevent|defend|protect|detect|stop|guard|block|mitigate|harden)\b/,
  /\bis\s+(?:this|that|it)\s+(?:a|an)\s+(?:prompt\s+injection|injection|jailbreak|phishing)\b/,
];
const NEGATED_FRAME = /^(?:(?:you\s+)?(?:must|should)\s+)?(?:do not|don't|dont|never|please do not|please don't)\b.{0,60}\b(?:ignore|disregard|forget|override|bypass|reveal|share|show|print|send|leak|expose|give|tell|repeat|output)\b/;

function protectedSentence(sentence) {
  if (NEGATED_FRAME.test(sentence)) return true;
  if (DIRECT_SECRET_AIM.test(sentence)) return false;
  return EXPLAIN_FRAMES.some((re) => re.test(sentence));
}

/* ── Rule patterns (run per sentence on the detection views) ─────────── */

const ASK = '(?:reveal|show|print|display|output|dump|list|give|tell|send|share|leak|expose|disclose|paste|read\\s+out|spell\\s+out|echo|return|provide|repeat|recite|write\\s+out|type\\s+out|copy|forward|email|post)';
const QUESTION = "(?:what(?:'s|\\s+is|\\s+are|\\s+was|\\s+were)|whats)";
const OWNER = "(?:your|ur|its|the\\s+(?:server|site|website|system|app|application|bot|ai|assistant|admin|administrator|backend|company|developer|dev|owner|database|db|service|api|platform|account|root|master|production|prod)(?:'s|s'|s)?|stored|saved|internal|hidden|secret|production|prod|admin|root|master|all\\s+(?:the\\s+|of\\s+the\\s+|your\\s+)?|any\\s+(?:of\\s+the\\s+|of\\s+your\\s+)?|other\\s+(?:users?|people|customers?)(?:'s|s'|s)?|every(?:one'?s)?)";
const SECRET = '(?:api[\\s_-]?keys?|access\\s+keys?|secret\\s+keys?|private\\s+keys?|ssh\\s+keys?|signing\\s+keys?|encryption\\s+keys?|passwords?|passwds?|passphrases?|pass\\s?codes?|pins?|credentials?|creds|(?:bearer|auth(?:entication)?|access|refresh|session|api|oauth|jwt)\\s+tokens?|tokens?|session\\s+cookies?|cookies|secrets?|connection\\s+strings?|(?:database|db)\\s+(?:urls?|uris?|passwords?|credentials?|logins?)|client\\s+secrets?|webhook\\s+secrets?|keys?\\s+(?:to|for)\\s+the\\s+\\w+)';

const RULE_PATTERNS = {
  'prompt-injection.override': [
    /\b(?:ignore|disregard|forget|override|bypass)\b.{0,40}\b(?:all|previous|prior|above|earlier|preceding|your|the)\s+(?:\w+\s+){0,2}?(?:instructions?|prompts?|directives?)\b(?!\s+in\s+the\s+(?:style\s+guide|document|manual|handbook|guide|memo|spec|contract|article|book|file|policy)\b)/,
    /<\|\s*(?:im_start|im_end|system|endoftext|start_header_id)\s*\|>/,
    /\[\/?inst\]|<<\/?sys>>/,
    /(?:^|\s)#{2,}\s*(?:system|new\s+instructions?)\s*(?:prompt)?\s*:/,
    /\[\s*(?:system|admin|developer)\s*(?:message|override|note)?\s*\]\s*:?/,
    /<\/?\s*system\s*>/,
    /\b(?:ignore|disregard|forget|override|bypass|drop|discard)\b.{0,30}\b(?:your|the|all|any)\s+(?:\w+\s+){0,2}(?:guidelines|guardrails|safety\s+rules|restrictions|filters|policies|programming|training|rules)\b/,
    // Non-English override phrasing (French, Spanish, Portuguese, German, Italian).
    /\b(?:ignorez|ignora|ignorar|ignoriere|ignorieren|ignorate|olvida|oubliez|vergiss)\b.{0,40}\b(?:instructions|instrucciones|instru[cç][oõ]es|anweisungen|istruzioni|r[eè]gles|reglas|regeln)\b/,
    /\b(?:stop|cease)\s+(?:following|obeying)\s+(?:your|the)\s+(?:\w+\s+){0,2}(?:instructions|rules|guidelines|prompt)\b/,
  ],
  'prompt-injection.indirect': [
    /\b(?:note|message|instructions?|attention)\s+(?:to|for)\s+(?:the\s+|any\s+)?(?:ai|a\.i\.|assistant|llm|chatbot|bot|language\s+model|model|agent|gpt|claude|gemini|grok)\b/,
    /\bif\s+you\s+are\s+(?:an?\s+)?(?:ai|assistant|llm|chatbot|bot|language\s+model|large\s+language\s+model|agent)\b/,
    /\b(?:ai|assistant|llm|chatbot|bot|model|agent)s?\s+(?:reading|processing|summari[sz]ing|parsing|analy[sz]ing|browsing)\s+(?:this|these)\b/,
    /\bwhen\s+(?:the\s+|an?\s+)?(?:ai|assistant|llm|chatbot|bot|model|agent)\s+(?:reads|summari[sz]es|processes|sees|parses)\s+this\b/,
    /<!--.{0,200}\b(?:ignore|instruction|assistant|ai\b|llm|system|reveal|send)\b/,
    /\bhidden\s+(?:instructions?|commands?)\s*(?::|for\s+the|to\s+the)|\bhidden\s+prompt\s+(?:for|to)\s+the\b/,
  ],
  'prompt-injection.roleplay': [
    /\b(?:pretend|act|behave|roleplay|role-play|role\s+play|imagine|simulate|respond|answer)\b.{0,60}\b(?:no|without|free\s+(?:of|from)|zero|any)\s+(?:\w+\s+){0,2}(?:restrictions|rules|filters|limits|limitations|guidelines|censorship|ethics|morals|safety|boundaries|guardrails|policies)\b/,
    /\byou\s+are\s+(?:now\s+)?(?:no\s+longer|not)\s+(?:bound|restricted|limited|an?\s+ai|an?\s+assistant|required\s+to\s+follow)\b/,
    /\b(?:developer|dev|god|debug|admin|sudo|jailbreak|unrestricted|unfiltered|uncensored|evil)\s+mode\b.{0,30}\b(?:enabled|activated|on|engaged)\b|\b(?:enable|activate|enter|turn\s+on|switch\s+to)\s+(?:god|sudo|jailbreak|unrestricted|unfiltered|uncensored|evil|dan)\s+mode\b|\byou\b.{0,30}\b(?:enable|activate|enter|switch\s+to)\s+(?:developer|dev|debug|admin)\s+mode\b/,
    /\bdo\s+anything\s+now\b|\byou\s+are\s+(?:now\s+)?dan\b|\bas\s+dan\b|\bdan\s+mode\b/,
    /\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|jailbroken|evil|amoral)\s+(?:ai|assistant|model|chatbot|bot|version)\b/,
    /\b(?:stay|remain)\s+in\s+character\b.{0,80}\b(?:no\s+matter|even\s+if|regardless)\b/,
    /\bjailbroken\b/,
    /\bmode\s+(?:with\s+)?(?:no|without|zero)\s+(?:\w+\s+)?(?:filters|restrictions|rules|limits|guardrails|censorship)\b/,
  ],
  'secret-fishing.credentials': [
    new RegExp(`\\b${ASK}\\b.{0,50}\\b${OWNER}\\s*(?:\\w+\\s+){0,3}?${SECRET}\\b`),
    new RegExp(`\\b${QUESTION}\\s+(?:the\\s+)?(?:value\\s+of\\s+|actual\\s+|real\\s+|current\\s+)?${OWNER}\\s*(?:\\w+\\s+){0,2}?${SECRET}\\b`),
    new RegExp(`\\b${ASK}\\b.{0,40}\\b${SECRET}\\b.{0,30}\\b(?:you|the\\s+(?:bot|ai|assistant|server|site|system))\\s+(?:have|has|use|uses|were\\s+given|store|stores|know|knows|are\\s+using|is\\s+using|were\\s+configured\\s+with|are\\s+configured\\s+with|were\\s+set\\s+up\\s+with|run\\s+with|have\\s+stored)\\b`),
    /\b(?:what|which)\s+(?:api\s*keys?|passwords?|tokens?|credentials?|secrets?|keys?)\s+(?:do|does|are|is|did)\s+(?:you|the\s+(?:bot|ai|assistant|server|site|system|app))\s+(?:use|using|have|hold|store|keep|configured|know|get)\b/,
    new RegExp(`\\b${ASK}\\b.{0,30}\\bwhat\\s+(?:api\\s*keys?|passwords?|tokens?|credentials?|secrets?)\\s+(?:you|the\\s+(?:bot|ai|assistant|server|site|system))\\b`),
  ],
  'secret-fishing.system-prompt': [
    new RegExp(`\\b${ASK}\\b.{0,40}\\b(?:your|the)\\s+(?:\\w+\\s+){0,2}?(?:system|initial|original|hidden|secret|developer|pre-?|base|full|exact)\\s*(?:prompt|instructions?|message|directives|configuration|rules)\\b`),
    new RegExp(`\\b${QUESTION}\\s+(?:your|the)\\s+(?:system|initial|original|hidden|secret|developer|base)\\s+(?:prompt|instructions?|message|directives)\\b`),
    new RegExp(`\\b${ASK}\\b.{0,30}\\byour\\s+(?:\\w+\\s+){0,2}?(?:prompt|instructions|directives|guidelines|rules)\\b.{0,30}\\b(?:verbatim|word\\s+for\\s+word|exactly|in\\s+full|in\\s+a\\s+code\\s+block)\\b`),
    /\b(?:repeat|print|output|recite|show|write|copy|echo)\b.{0,30}\b(?:everything|all|the\s+(?:text|words|message|content|lines?)|what\s+(?:is|was|came))\b.{0,20}\b(?:above|before\s+(?:this|my|the\s+(?:first|user))|preceding|prior\s+to\s+(?:this|my))\b/,
    /\b(?:repeat|print|output)\b.{0,30}\bwords?\s+above\b|\bstarting\s+with\s+["']?you\s+are\b/,
    new RegExp(`\\b${QUESTION}\\s+(?:your|the)\\s+(?:instructions|rules|directives)\\b(?!\\s+(?:for|on|to)\\s)`),
    new RegExp(`\\b${ASK}\\b.{0,30}\\b(?:full\\s+)?(?:text|content|contents|copy|wording|list)\\s+of\\s+your\\s+(?:\\w+\\s+){0,2}?(?:instructions|prompt|rules|directives|guidelines)\\b`),
    /\b(?:translate|summari[sz]e|paraphrase|rewrite|encode|convert|spell\s+out|base64)\b.{0,20}\byour\s+(?:system|initial|hidden|original|secret)\s+(?:prompt|instructions)\b/,
    /\bwhat\s+(?:were|are|was)\s+you\s+(?:told|instructed|programmed|configured|prompted)\s+(?:to\s+do\s+)?(?:before|at\s+the\s+start|initially|originally)\b/,
  ],
  'secret-fishing.env-config': [
    /\b(?:print|dump|show|output|log|return|send|reveal|list|display|echo|give|tell)\b.{0,30}\b(?:process\.env|os\.environ|\$env:|getenv\(\)|all\s+(?:the\s+|of\s+the\s+)?(?:env\s+vars?|environment\s+variables?|envvars|secrets))\b(?!\.\w|\[|\s*\.\s*\w)/,
    new RegExp(`\\b(?:${ASK}|${QUESTION})\\b.{0,30}\\b(?:your|the\\s+(?:server|site|app|bot|system|production|prod)(?:'s)?)\\s+(?:\\w+\\s+){0,2}?(?:env(?:ironment)?(?:\\s+vars?|\\s+variables?)?|\\.env(?:\\s+file)?|config(?:uration)?\\s+files?|settings\\s+files?|secrets?\\s+files?|config\\.json|appsettings|wp-config(?:\\.php)?|vercel\\s+env)\\b`),
    /\b(?:cat|type|more|less|head|tail|get-content|gc|open|read|show|print|display|send|upload|curl|base64)\b.{0,25}(?:^|[\s'"/~])(?:\.env(?:\.local|\.production)?|id_rsa|id_ed25519|\.ssh\/|\.aws\/credentials|\/etc\/shadow|\/etc\/passwd|\.git-credentials|\.netrc|\.pgpass|\.npmrc|wp-config\.php|appsettings\.json|secrets\.ya?ml)\b/,
    /^(?:[$>#]\s*)?(?:(?:please\s+)?(?:run|execute|type|exec)\s+)?(?:printenv|env|set|get-childitem\s+env:|gci\s+env:|ls\s+env:|dir\s+env:)\s*(?:$|[|;&>])/,
    /\becho\s+\$\{?[a-z_]*(?:key|token|secret|password|passwd|pwd|database_url|db_url|conn)[a-z_]*\}?/,
    /\b(?:what\s+is|what's|print|show|reveal|tell\s+me|give\s+me|echo|output)\b.{0,20}\bthe\s+value\s+of\s+[a-z0-9_]*(?:_key|_token|_secret|_password|password|secret|api_key|database_url|_url)\b/,
  ],
  'data-exfiltration.ask': [
    /\b(?:send|post|upload|email|e-mail|forward|transmit|exfiltrate|leak|submit|beam|sync|pipe|curl|wget|fetch|make\s+a\s+request|webhook)\b.{0,60}\b(?:conversation|chat\s+(?:history|log)|this\s+chat|(?:all|the|other|every)\s+(?:\w+\s+)?messages|history|user\s+data|customer\s+(?:data|list|records|emails)|database|db\s+dump|records|secrets|credentials|api\s+keys?|tokens|passwords|system\s+prompt|private\s+data|personal\s+data|everything\s+(?:you|in))\b.{0,60}\b(?:to|at|into|via)\b.{0,12}(?:https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+|webhook|pastebin|ngrok|requestbin|burp|interact\.sh|discord\.com\/api\/webhooks|my\s+server|this\s+url|this\s+address|an?\s+(?:external|outside|remote)\s+(?:server|url|address))/,
    /!\[[^\]]{0,80}\]\(\s*https?:\/\/[^)\s]{1,200}[?&][^)\s=]{1,40}=\s*(?:\{|\$|%7b|\[|<)/,
    /\b(?:encode|embed|append|include|put|hide)\b.{0,40}\b(?:conversation|chat|secrets?|credentials?|api\s+keys?|tokens?|passwords?|system\s+prompt|user\s+data|data)\b.{0,40}\b(?:in|into|as|to)\s+(?:the\s+|a\s+)?(?:url|link|query\s+string|image\s+(?:url|link)|markdown\s+image|dns\s+(?:query|lookup))\b/,
    /\b(?:list|show|give|dump|export|tell|send|share|print|display|reveal)\b.{0,30}\b(?:all|every|other|each)\s+(?:\w+\s+){0,1}(?:users?|customers?|members?|accounts?|people|clients?|visitors?|patients?|employees?)(?:'s|s'|s)?\s+(?:\w+\s+){0,2}?(?:emails?|e-mail\s+addresses|phone\s+numbers?|phones|addresses|passwords|personal\s+(?:data|info|information|details)|private\s+(?:data|info)|records|credit\s+cards?|ssns?|social\s+security|contact\s+(?:details|info))\b/,
  ],
};

// The legacy weak markers (formerly the only injection screen). Kept, but
// flag-only by default: each one also matches ordinary text.
const WEAK_MARKERS = [
  { hit: 'prompt-injection.role-marker', re: /^\s*(?:system|assistant)\s*:/im },
  { hit: 'prompt-injection.jailbreak', re: /jailbreak/i },
];

function matchRules(view) {
  const found = new Set();
  for (const sentence of sentences(view)) {
    if (protectedSentence(sentence)) continue;
    for (const [id, patterns] of Object.entries(RULE_PATTERNS)) {
      if (found.has(id)) continue;
      if (patterns.some((re) => re.test(sentence))) found.add(id);
    }
  }
  return found;
}

/**
 * Screen one piece of inbound text against the attack rules.
 * Returns { hits: [{ rule, class, action }], blocked } — rule ids only,
 * never the matched text, so a finding built from it carries no content.
 * Rules set to 'off' in the policy are not reported.
 */
export function screenAttackRules(body, { policy = resolveSiteGuardPolicy() } = {}) {
  const original = String(body ?? '').slice(0, MAX_RULE_CHARS);
  const fired = new Map();
  const fire = (rule) => {
    if (fired.has(rule) || !SITE_GUARD_RULES[rule]) return;
    const action = policy[rule] ?? SITE_GUARD_RULES[rule].defaultAction;
    if (action === SITE_GUARD_ACTION.OFF) return;
    fired.set(rule, { rule, class: SITE_GUARD_RULES[rule].class, action });
  };
  if (!original.trim()) return Object.freeze({ hits: Object.freeze([]), blocked: false });

  const plain = rawView(original);
  const plainHits = matchRules(plain);
  for (const id of plainHits) fire(id);

  // Disguised forms: anything that fires only after normalization,
  // leetspeak folding or decoding is also an obfuscated attack.
  const disguised = new Set();
  const norm = normalizedView(original);
  const views = [norm, leetView(norm), ...decodings(original).flatMap((d) => { const v = normalizedView(d); return [v, leetView(v)]; })].filter(Boolean);
  for (const view of views) {
    if (view === plain) continue;
    for (const id of matchRules(view)) {
      if (!plainHits.has(id)) disguised.add(id);
      fire(id);
    }
  }

  // The instruction-override kernel (src/core/injection-risk.mjs), with
  // its own normalization and one-level decode pass.
  // Run per sentence so the same protective frames apply to it.
  for (const sentence of String(original).split(/(?<=[.!?;])\s+|\n+/)) {
    if (!sentence.trim() || protectedSentence(rawView(sentence))) continue;
    const kernel = scanInjection(sentence);
    if (!kernel.hits.length) continue;
    fire('prompt-injection.override');
    if (kernel.hits.some((h) => h.decoded) || !matchRules(rawView(sentence)).has('prompt-injection.override')) disguised.add('prompt-injection.override');
  }
  if (disguised.size) fire('prompt-injection.obfuscated');

  for (const marker of WEAK_MARKERS) {
    if (marker.re.test(original)) { fire('prompt-injection.weak-marker'); break; }
  }

  const hits = Object.freeze([...fired.values()].map((h) => Object.freeze(h)));
  return Object.freeze({ hits, blocked: hits.some((h) => h.action === SITE_GUARD_ACTION.BLOCK) });
}

export function siteGuardRuleLabel(rule) {
  return SITE_GUARD_RULES[rule]?.label ?? rule;
}
