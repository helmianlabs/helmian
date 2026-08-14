import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../web/cloud-admin/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../web/cloud-admin/app.js', import.meta.url), 'utf8');
const liveAdmin = await readFile(new URL('../src/cloud/live-admin.mjs', import.meta.url), 'utf8');

test('authenticated shell navigation names real product surfaces and remains role-aware', () => {
  for (const target of ['section-chat', 'section-cora', 'section-prepare', 'section-artifact', 'section-governance']) assert.match(page, new RegExp(`data-target="${target}"`, 'u'));
  assert.match(page, /data-admin-only/iu);
  assert.match(script, /adminNav\.hidden\s*=\s*!isAdmin/u);
  assert.match(page, /Search stored approved sources/iu);
  assert.match(page, /Organization scope/u);
  assert.doesNotMatch(page, /READ-ONLY PREVIEW/u);
});

test('shell does not present Plant/facility authority or fabricated execution', () => {
  assert.doesNotMatch(page, /plant selector|facility selector|choose a plant|choose a facility/iu);
  assert.match(page, /No audited status/u);
  assert.match(page, /no agent execution is implied/u);
  assert.match(page, /Preview · not executed/u);
  assert.match(page, /external execution and browser automation are unavailable/u);
  assert.match(page, /stored excerpts with citations only/u);
  assert.match(page, /Artifact Studio/u);
  assert.match(page, /Manual script and narration draft/u);
  assert.match(page, /Execution request preflight/u);
  assert.match(page, /approval-required, blocked, and queued states all remain not executed/iu);
  assert.match(script, /No generation occurred/u);
  assert.match(liveAdmin, /LIVE_ADMIN_CORA_ARTIFACT_EXECUTION_PATH = '\/api\/admin\/cora\/artifact-execution-requests'/u);
  assert.match(liveAdmin, /artifactExecution\.append\(actor, body\)/u);
  assert.match(page, /approved, queued, running, provider result, accepted, and rejected execution stages are not performed/u);
});
