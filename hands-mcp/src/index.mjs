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
const audit = createAudit(`${config.stateDir}/audit.jsonl`);
// Scope reporting (scope-permission spec, bite 1): the hub surfaces a spoke's
// first scope report and every change from the last one; both land in the
// audit as scope.reported, changes flagged with the previous summary.
const hub = createSpokeHub({
  onCapabilitiesReport: ({ deviceId, capabilities, previous }) => audit.append({ event: 'capabilities.reported', deviceId, capabilities, previous }),
  onScopeReport: ({ deviceId, scope, changed, first = false, previous = null }) => audit.append({
    event: 'scope.reported', deviceId, tier: scope.tier, roots: scope.roots, grants: scope.grants,
    changed, ...(first ? { first: true } : {}), ...(previous ? { previous } : {}),
  }),
});
const hands = createHands({ config, guard, hub, audit });
const spokeTokens = createSpokeTokens({ file: `${config.stateDir}/spoke-tokens.json`, passphrase: config.passphrase, staticToken: config.spokeToken });
const app = createApp({ config, oauth, hands, hub, spokeTokens });
app.listen(config.port, () => {
  console.error(`helmian-hands-mcp on :${config.port} public=${config.publicUrl} hands=${config.handsEnabled ? 'on' : 'off'} guard=${guard.live ? 'live' : 'NOT LIVE (mutating denied)'}`);
});
