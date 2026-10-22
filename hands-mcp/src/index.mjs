import { loadConfig } from './config.mjs';
import { createOAuth } from './oauth.mjs';
import { createGuardClient } from './guard-client.mjs';
import { createSpokeHub } from './spoke-hub.mjs';
import { createAudit } from './audit.mjs';
import { createHands } from './hands.mjs';
import { createApp } from './server.mjs';
import { createSpokeTokens } from './spoke-tokens.mjs';

const config = loadConfig();
const oauth = createOAuth({ resourceId: `${config.publicUrl}${config.mcpPath}`, stateFile: `${config.stateDir}/oauth-state.json` });
setInterval(() => oauth.sweep(), 60_000).unref();
const guard = createGuardClient(config.guard);
const hub = createSpokeHub();
const audit = createAudit(`${config.stateDir}/audit.jsonl`);
const hands = createHands({ config, guard, hub, audit });
const spokeTokens = createSpokeTokens({ file: `${config.stateDir}/spoke-tokens.json`, passphrase: config.passphrase, staticToken: config.spokeToken });
const app = createApp({ config, oauth, hands, hub, spokeTokens });
app.listen(config.port, () => {
  console.error(`helmian-hands-mcp on :${config.port} public=${config.publicUrl} hands=${config.handsEnabled ? 'on' : 'off'} guard=${guard.live ? 'live' : 'NOT LIVE (mutating denied)'}`);
});
