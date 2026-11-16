import { loadConfig } from './config.mjs';
import { createOAuth } from './oauth.mjs';
import { createBackends } from './backends.mjs';
import { createApp } from './server.mjs';

const config = loadConfig();
const oauth = createOAuth({ resourceId: `${config.publicUrl}${config.mcpPath}`, stateFile: `${config.stateDir}/oauth-state.json` });
setInterval(() => oauth.sweep(), 60_000).unref();
const backends = createBackends({ config, file: `${config.stateDir}/backend-tokens.json` });
const app = createApp({ config, oauth, backends });

// Loopback bind only: Caddy is the public way in, and the backends are
// reached over the same host loopback (test gateway runs with host
// networking — see the one-door plan, section 7).
app.listen(config.port, '127.0.0.1', () => {
  console.error(`helmian-door-test on 127.0.0.1:${config.port} public=${config.publicUrl} backends: memory=${backends.ready('memory')} hands=${backends.ready('hands')}`);
});
