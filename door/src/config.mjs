// Configuration from the environment, same style as the hands server.
// Secrets live in /opt/helmian-door-test/app.env (chmod 600) on the box.
//
// Required:
//   PUBLIC_URL             canonical https URL of the door, no trailing slash
//                          (test: https://scribe.helmian.cloud/door)
//   AUTH_PASSPHRASE        the same passphrase as the memory/hands connectors
//   MEMORY_BACKEND_RESOURCE  canonical resource id of the memory backend
//                            (required for the combined and scribe flavours)
//   HANDS_BACKEND_RESOURCE   canonical resource id of the hands backend
//                            (required for the combined and helmian flavours)
// Optional:
//   DOOR_FLAVOUR           combined (default) | scribe | helmian. The
//                          combined door fronts both backends, as the door
//                          has always run. The scribe flavour fronts the
//                          memory backend only; the helmian flavour fronts
//                          the hands backend only (the separation split:
//                          one codebase, one flavour per product's door).
//   PORT                   default 8098
//   STATE_DIR              default /data
//   MEMORY_BACKEND_BASE    loopback base of the memory backend (default http://127.0.0.1:8081)
//   HANDS_BACKEND_BASE     loopback base of the hands backend (default http://127.0.0.1:8090)

function required(env, name) {
  const v = env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing required environment variable: ${name}`);
  return String(v).trim();
}

const FLAVOURS = Object.freeze(['combined', 'scribe', 'helmian']);

// The scopes each flavour can grant: two per backend, exactly the scopes
// the backends themselves already use.
const FLAVOUR_SCOPES = Object.freeze({
  combined: Object.freeze(['memory.read', 'memory.write', 'hands.read', 'hands.act']),
  scribe: Object.freeze(['memory.read', 'memory.write']),
  helmian: Object.freeze(['hands.read', 'hands.act']),
});
// No scopes requested on the consent URL -> read-only door.
const FLAVOUR_DEFAULT_SCOPES = Object.freeze({
  combined: Object.freeze(['memory.read', 'hands.read']),
  scribe: Object.freeze(['memory.read']),
  helmian: Object.freeze(['hands.read']),
});

export function loadConfig(env = process.env) {
  const flavour = String(env.DOOR_FLAVOUR || 'combined').trim().toLowerCase();
  if (!FLAVOURS.includes(flavour)) {
    throw new Error(`Unknown DOOR_FLAVOUR: ${flavour} (expected one of ${FLAVOURS.join(', ')})`);
  }
  const backends = {};
  if (flavour === 'combined' || flavour === 'scribe') {
    backends.memory = Object.freeze({
      base: (env.MEMORY_BACKEND_BASE || 'http://127.0.0.1:8081').replace(/\/+$/, ''),
      resource: required(env, 'MEMORY_BACKEND_RESOURCE'),
    });
  }
  if (flavour === 'combined' || flavour === 'helmian') {
    backends.hands = Object.freeze({
      base: (env.HANDS_BACKEND_BASE || 'http://127.0.0.1:8090').replace(/\/+$/, ''),
      resource: required(env, 'HANDS_BACKEND_RESOURCE'),
    });
  }
  return Object.freeze({
    flavour,
    scopes: FLAVOUR_SCOPES[flavour],
    defaultScopes: FLAVOUR_DEFAULT_SCOPES[flavour],
    publicUrl: required(env, 'PUBLIC_URL').replace(/\/+$/, ''),
    passphrase: required(env, 'AUTH_PASSPHRASE'),
    port: parseInt(env.PORT || '8098', 10),
    mcpPath: '/mcp',
    stateDir: (env.STATE_DIR || '/data').replace(/\/+$/, ''),
    backends: Object.freeze(backends),
    // Executive Guard approver access for the Scribe approvals page
    // (src/approvals.mjs). Optional: without GUARD_APPROVER_TOKEN the
    // approvals routes stay off (fail closed). GUARD_URL defaults to the
    // Guard service on this host's loopback.
    guard: Object.freeze({
      url: (env.GUARD_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
      approverToken: env.GUARD_APPROVER_TOKEN ? String(env.GUARD_APPROVER_TOKEN).trim() : null,
    }),
  });
}

export const AUTH_CODE_TTL_SECONDS = 600;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

// The combined door's scope set, kept as the static default: two per
// backend, exactly the scopes the backends themselves already use.
// loadConfig returns the per-flavour set (config.scopes /
// config.defaultScopes); these statics are the fallback when a caller
// does not pass a set in.
export const SCOPES = Object.freeze(['memory.read', 'memory.write', 'hands.read', 'hands.act']);
// No scopes requested on the consent URL -> read-only door.
export const DEFAULT_SCOPES = Object.freeze(['memory.read', 'hands.read']);
