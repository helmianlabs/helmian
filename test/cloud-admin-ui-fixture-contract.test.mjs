import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createEnvoyClient } from '../web/cloud-admin/envoy-client.mjs';
import { createCoraConfigClient, agentTaskPanelModel, knowledgeQueryModel, usagePanelModel, workspacePreviewPanelModel } from '../web/cloud-admin/cora-config-client.mjs';
import { CLOUD_ADMIN_UI_FIXTURES, createCloudAdminFixtureFetch } from './fixtures/cloud-admin-ui-fixtures.mjs';

const page = await readFile(new URL('../web/cloud-admin/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../web/cloud-admin/app.js', import.meta.url), 'utf8');

test('local UI fixtures cover every requested authenticated state without secrets or authority selectors', () => {
  assert.deepEqual(Object.keys(CLOUD_ADMIN_UI_FIXTURES.session).sort(), ['admin', 'member']);
  assert.deepEqual(Object.keys(CLOUD_ADMIN_UI_FIXTURES.envoy).sort(), ['connected', 'empty', 'loading', 'pollingFallback', 'reconnecting', 'revoked']);
  assert.ok(CLOUD_ADMIN_UI_FIXTURES.cora.published.config);
  assert.equal(CLOUD_ADMIN_UI_FIXTURES.preparation.prepared.receipts[0].execution, 'not_performed');
  const serialized = JSON.stringify(CLOUD_ADMIN_UI_FIXTURES);
  assert.doesNotMatch(serialized, /secret|credential|api[_-]?key|password|authorization: Bearer/iu);
  assert.doesNotMatch(page, /plant selector|facility selector|choose a plant|choose a facility/iu);
  assert.doesNotMatch(script, /[?&](?:tenant|organization|plant|facility)(?:_id|Id)?=/iu);
});

test('fake route adapter exercises Envoy, Cora, preparation, and role-aware client contracts', async () => {
  const fetchImpl = createCloudAdminFixtureFetch({ role: 'member', envoy: 'empty', knowledge: 'knowledgeMatch', usage: 'usageSoft', preparation: 'replayed' });
  const envoy = createEnvoyClient({ fetchImpl });
  const cora = createCoraConfigClient({ fetchImpl });
  assert.equal((await envoy.listChannels()).channels.length, 0);
  assert.equal((await cora.queryKnowledge('fixture')).excerpts.length, 1);
  assert.equal(usagePanelModel(await cora.readUsage()).state, 'soft');
  assert.equal(workspacePreviewPanelModel(await cora.readWorkspacePreviews()).execution, 'not_performed');
  assert.equal(agentTaskPanelModel(await cora.readAgentTasks()).receipts[0].replayed, true);
  assert.equal(knowledgeQueryModel(await cora.queryKnowledge('fixture')).answer, null);
  assert.equal(fetchImpl.calls.every(({ options }) => options.credentials === 'same-origin'), true);
  assert.equal(fetchImpl.calls.some(({ url }) => /tenant|organization|plant|facility/iu.test(url)), false);
});

test('fixture models preserve truthful empty and unavailable states', () => {
  assert.equal(knowledgeQueryModel(CLOUD_ADMIN_UI_FIXTURES.cora.knowledgeEmpty).status, 'no_approved_source_match');
  assert.equal(usagePanelModel(CLOUD_ADMIN_UI_FIXTURES.cora.usageEmpty).empty, true);
  assert.equal(usagePanelModel(CLOUD_ADMIN_UI_FIXTURES.cora.usageHard).state, 'hard');
  assert.equal(workspacePreviewPanelModel(CLOUD_ADMIN_UI_FIXTURES.preparation.empty).empty, true);
  assert.equal(agentTaskPanelModel(CLOUD_ADMIN_UI_FIXTURES.preparation.prepared).execution, 'not_performed');
});

test('fixture persists Organization workspace layout presets through the real client contract', async () => {
  const fetchImpl = createCloudAdminFixtureFetch();
  const cora = createCoraConfigClient({ fetchImpl });
  const focus = { visibleShelves: ['chat', 'prepare'], panelOrder: ['chat', 'prepare'], density: 'comfortable', defaultEnvoyChannelId: null };
  assert.deepEqual((await cora.saveWorkspaceLayout(focus)).layout, focus);
  assert.deepEqual((await cora.readWorkspaceLayout()).layout, focus);
  assert.match(fetchImpl.calls.map(({ url }) => url).join('\n'), /workspace\/layout-preferences/u);
});
