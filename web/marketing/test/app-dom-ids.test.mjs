import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// Regression: removing #session-label from index.html (1df4c0f) made boot() throw
// in renderSessions for every signed-in member, so /app never left its default view.
test('every #id that app.js looks up unguarded exists in /app/index.html', async () => {
  const js = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const present = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const dynamic = new Set([...js.matchAll(/id="([^"]+)"/g), ...js.matchAll(/\.id\s*=\s*'([^']+)'/g)].map((m) => m[1]));
  const guarded = new Set([...js.matchAll(/const \w+ = \$\('#([A-Za-z0-9_-]+)'\); if \(\w+\)/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !present.has(id) && !dynamic.has(id) && !guarded.has(id));
  assert.deepEqual(missing, []);
});
