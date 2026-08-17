import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);

test('Hosted History is a standalone Desktop-style audit projection', async () => {
  const [page, script] = await Promise.all([
    readFile(new URL('web/cloud-history/index.html', root), 'utf8'),
    readFile(new URL('web/cloud-history/app.js', root), 'utf8'),
  ]);
  for (const id of ['activity-count', 'activity-filters', 'activity-action', 'activity-actor', 'activity-decision', 'activity-from', 'activity-to', 'activity-clear', 'activity-items', 'load-older']) assert.match(page, new RegExp(`id="${id}"`, 'u'));
  assert.match(page, /read-only durable audit view/u);
  assert.match(script, /fetch\(`\/api\/admin\/events\?\$\{paramsForRequest\(append\)\}`/u);
  assert.match(script, /credentials: 'same-origin'/u);
  assert.match(script, /params\.set\('cursor', cursor\)/u);
  assert.doesNotMatch(script, /tenant_id|organization_id|plant_id|facility_id/u);
});
