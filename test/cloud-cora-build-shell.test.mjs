import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../web/cloud-cora-build/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../web/cloud-cora-build/app.js', import.meta.url), 'utf8');

test('Cora Build Studio exposes the governed receipt sequence without claiming execution', () => {
  assert.match(page, /Describe a request to create a draft/u);
  assert.match(page, /Queueing is not execution/u);
  assert.match(page, /verified GitHub source binding and a real worker runtime exist/u);
  assert.match(page, /does not verify a source, make a checkout, change files, publish, or deploy/u);
  assert.match(page, /src="\/admin\/cora\/build\/assets\/app\.js"/u);
  assert.doesNotMatch(page, /id="(?:tenant|oauth|token|credential|repository-url)/iu);
});

test('Cora Build Studio sends closed same-origin request bodies and hides controls for members', () => {
  assert.match(script, /credentials: 'same-origin'/u);
  assert.match(script, /form\.hidden = !visible/u);
  assert.match(script, /body: JSON\.stringify\(\{ userRequest \}\)/u);
  assert.match(script, /appBuildReceiptId: revisionDraft\.value/u);
  assert.match(script, /revisionReceiptId: approvalRevision\.value/u);
  assert.match(script, /approvalReceiptId: queueApproval\.value\.trim\(\)/u);
  assert.match(script, /workspaceProjectKey: queueProject\.value/u);
  assert.match(script, /textContent/u);
  assert.doesNotMatch(script, /innerHTML/u);
});
