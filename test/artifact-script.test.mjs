import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArtifactScriptReceipt, normalizeArtifactScript } from '../src/cora/artifact-script.mjs';

const script = { artifactReceiptId: 'artifact-1', scriptKind: 'narration', text: 'Welcome to the dock orientation.', sourceLinkReceiptIds: ['link-0001'], stage: 'draft', idempotencyKey: 'script-0001' };

test('manual Artifact Studio scripts are bounded, revision-ready, and never generated', () => {
  const receipt = buildArtifactScriptReceipt({ script, receiptId: 'receipt-0001', revision: 1 });
  assert.equal(receipt.draftState, 'prepared'); assert.equal(receipt.generation, 'not_generated'); assert.equal(receipt.providerInvocation, 'not_performed');
  assert.throws(() => normalizeArtifactScript({ ...script, plantId: 'west' }), /Plant/);
  assert.throws(() => normalizeArtifactScript({ ...script, prompt: 'secret' }), /unsupported/);
  assert.throws(() => normalizeArtifactScript({ ...script, stage: 'source_checked', sourceLinkReceiptIds: [] }), /source links|invalid/);
});
