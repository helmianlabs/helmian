import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);

test('Hosted Workspace Project Shelf mirrors Desktop filtering and makes no execution claim', async () => {
  const [page, script] = await Promise.all([
    readFile(new URL('web/cloud-workspace/index.html', root), 'utf8'),
    readFile(new URL('web/cloud-workspace/app.js', root), 'utf8'),
  ]);
  for (const id of ['project-count', 'workspace-status', 'project-search', 'active-filter', 'archived-filter', 'project-clear', 'project-list', 'registration', 'project-key', 'project-name', 'project-source', 'project-branch', 'project-save']) assert.match(page, new RegExp(`id="${id}"`, 'u'));
  assert.match(page, /does not open a local folder or execute work/u);
  assert.match(script, /fetch\('\/api\/admin\/workspace\/projects', \{ credentials:'same-origin' \}\)/u);
  assert.match(script, /method:'POST', credentials:'same-origin'/u);
  assert.match(script, /project\.lifecycle === lifecycle/u);
  assert.match(script, /does not open a local folder or execute project work/u);
  assert.doesNotMatch(script, /tenant_id|organization_id|plant_id|facility_id/u);
});
