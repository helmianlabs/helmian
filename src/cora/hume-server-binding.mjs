const SECRET_KEY = /(secret|token|password|api[_-]?key|credential|private[_-]?key|database[_-]?url|connection[_-]?string)/iu;
const MAX_CONFIG_ID_CHARS = 128;
const SOURCES = new Set(['server_process_env', 'injected_test']);

function rejectSecrets(value, path = 'serverBinding') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'credentialReady' && SECRET_KEY.test(key)) throw new Error(`${path}.${key} is secret-bearing`);
    rejectSecrets(child, `${path}.${key}`);
  }
}

function optionalId(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const result = String(value).trim();
  if (result.length > MAX_CONFIG_ID_CHARS || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error('server Hume config reference is invalid');
  return result;
}

/** Normalize only non-secret server readiness metadata; never a credential. */
export function resolveServerHumeBinding(binding = null) {
  if (binding === null || binding === undefined) return Object.freeze({ state: 'unavailable', configId: null, credentialReady: false, source: 'server_binding_absent' });
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error('server Hume binding metadata is invalid');
  rejectSecrets(binding);
  const source = String(binding.source ?? '').trim();
  if (!SOURCES.has(source)) throw new Error('server Hume binding source is invalid');
  if (typeof binding.credentialReady !== 'boolean') throw new Error('server Hume credential readiness must be explicit');
  const configId = optionalId(binding.configId);
  const configured = binding.configured === true;
  return Object.freeze({ state: configured && configId && binding.credentialReady ? 'ready' : 'unavailable', configId: configured ? configId : null, credentialReady: configured && binding.credentialReady, source });
}
