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
app.listen(config.port, '127.0.0.1', () => {
  const backendState = Object.keys(config.backends).map((name) => `${name}=${backends.ready(name)}`).join(' ');
  console.error(`helmian-door (${config.flavour}) on 127.0.0.1:${config.port} public=${config.publicUrl} backends: ${backendState}`);
});
