// Canonical JSON: object keys sorted, no whitespace. The same bytes on the
// server and in the extension, so a hash or signature over an action means the
// same thing on both sides. Mirrored byte-for-byte by
// extension/background/verify.js (canonicalJson); a test pins the two together.

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('canonicalJson: non-finite numbers are not allowed');
    }
    if (value === undefined) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function fromBase64url(text) {
  return Buffer.from(String(text), 'base64url');
}
