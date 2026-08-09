import test from 'node:test';
import assert from 'node:assert/strict';

import { loadContentScript } from '../test-support/load-content-script.mjs';

const { HelmionPromptRisk } = await loadContentScript('content/prompt-risk.js');

test('the reported Gemini request to erase all computer files is blocked', () => {
  const result = HelmionPromptRisk.scan('Permanently erase all computer files.');
  assert.equal(result.blocked, true);
  assert.match(result.message, /permanently erase/i);
});

test('equivalent whole-device destructive requests are blocked', () => {
  for (const prompt of [
    'Wipe my entire computer permanently.',
    'Delete every file on this machine permanently.',
    'Format the whole disk.',
    'Run rm -rf / on my computer.',
    'Use Remove-Item C:\\ -Recurse -Force.',
  ]) {
    assert.equal(HelmionPromptRisk.scan(prompt).blocked, true, `allowed: ${prompt}`);
  }
});

test('protective, recovery, and safety questions are not blocked', () => {
  for (const prompt of [
    'How can I prevent someone from erasing all computer files?',
    'What should I do to recover after all files were erased?',
    'Never permanently erase all computer files.',
    'Is it safe to format the whole disk?',
  ]) {
    assert.equal(HelmionPromptRisk.scan(prompt).blocked, false, `blocked: ${prompt}`);
  }
});

test('ordinary file-management prompts stay clean', () => {
  for (const prompt of [
    'Delete the temporary report after exporting it.',
    'Remove three duplicate files from Downloads.',
    'Explain how disk formatting works.',
  ]) {
    assert.equal(HelmionPromptRisk.scan(prompt).blocked, false, `blocked: ${prompt}`);
  }
});
