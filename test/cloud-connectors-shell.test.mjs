import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../web/cloud-connectors/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../web/cloud-connectors/app.js', import.meta.url), 'utf8');

test('hosted connectors keeps registered metadata distinct from live OAuth/provider connection', () => {
  assert.match(page, /registered connector is not a connected OAuth provider/u);
  assert.match(page, /never accepts OAuth codes, access tokens, API keys, repository URLs, or tenant selectors/u);
  assert.match(script, /credentials: 'same-origin'/u);
  assert.match(script, /form\.hidden = !isAdmin/u);
  assert.match(script, /textContent/u);
  assert.doesNotMatch(page, /id="(?:oauth|token|api-key|repository-url)/iu);
});
