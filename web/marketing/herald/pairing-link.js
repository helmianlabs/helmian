// Browser copy of src/herald/pairing-link.mjs — test/herald-pairing-link.test.mjs keeps them identical.
// Helmian Herald QR pairing links (format v1).
//
//   Account Remote Control enrollment (the Desktop "Phone" card):
//     https://helmian.vercel.app/herald/#enroll=12345678
//   Relay channel pairing ("Start phone sharing"):
//     https://helmian.vercel.app/herald/?channel=herald_…#pair=12345678
//
// The one-time code rides in the URL *fragment*. Browsers never send the
// fragment to a server, so it stays out of relay access logs, proxies and
// Referer headers. The phone reads it, scrubs it from the address bar/history
// right away, then submits it through the existing endpoints. Server rules are
// unchanged and still decide: codes are hashed, single-use, short-lived and
// attempt-limited, so a photographed QR is useless after first use or expiry.

export const ENROLL_FRAGMENT_KEY = 'enroll';
export const PAIR_FRAGMENT_KEY = 'pair';
const KEYS = new Set([ENROLL_FRAGMENT_KEY, PAIR_FRAGMENT_KEY]);
const CODE_PATTERN = /^\d{8}$/;

// Same-Wi-Fi fallback: loopback or RFC1918 IPv4 only, never a public host.
function isLocalHost(host) {
  if (host === 'localhost' || host === '127.0.0.1') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function digits(code) {
  return String(code ?? '').replace(/\D/g, '');
}

export function buildPairingLink(baseUrl, code, key = PAIR_FRAGMENT_KEY) {
  if (!KEYS.has(key)) throw new TypeError('Unknown pairing link kind.');
  const url = new URL(String(baseUrl));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new TypeError('Pairing links must use HTTPS (loopback / private Wi-Fi excepted).');
  }
  if (url.username || url.password) throw new TypeError('Pairing links must not embed credentials.');
  const value = digits(code);
  if (!CODE_PATTERN.test(value)) throw new TypeError('Pairing code must be 8 digits.');
  url.hash = `${key}=${value}`;
  return url.toString();
}

export function readPairingCodeFromHash(hash, key = PAIR_FRAGMENT_KEY) {
  const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
  const value = digits(params.get(key));
  return CODE_PATTERN.test(value) ? value : null;
}

// Reads the code once and removes it from the visible URL and history entry.
export function takePairingCodeFromLocation(loc, hist, key = PAIR_FRAGMENT_KEY) {
  const code = readPairingCodeFromHash(loc?.hash, key);
  if (code && hist?.replaceState) {
    try { hist.replaceState(hist.state ?? null, '', `${loc.pathname}${loc.search}`); } catch { /* best effort */ }
  }
  return code;
}
