import { loadConfig } from './config.mjs';
import { createOAuth } from './oauth.mjs';
import { createBackends } from './backends.mjs';
import { createApp } from './server.mjs';

const config = loadConfig();
const oauth = createOAuth({ resourceId: `${config.publicUrl}${config.mcpPath}`, stateFile: `${config.stateDir}/oauth-state.json`, scopes: config.scopes, defaultScopes: config.defaultScopes, flavour: config.flavour });
setInterval(() => oauth.sweep(), 60_000).unref();
const backends = createBackends({ config, file: `${config.stateDir}/backend-tokens.json` });
const app = createApp({ config, oauth, backends });

// Loopback bind only: Caddy is the public way in, and the backends are
// reached over the same host loopback (test gateway runs with host
// networking — see the one-door plan, section 7).
const server = app.listen(config.port, '127.0.0.1', () => {
  const backendState = Object.keys(config.backends).map((name) => `${name}=${backends.ready(name)}`).join(' ');
  console.error(`helmian-door (${config.flavour}) on 127.0.0.1:${config.port} public=${config.publicUrl} backends: ${backendState}`);
});
// Slow-request bounds (Helmian Site Guard HTTP layer, see
// docs/SECURITY_EDGE_AND_TRANSPORT.md): a client gets 15 s to send its
// headers and 30 s to send the whole request. Responses (long polls,
// streams) are not limited by these.
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;
