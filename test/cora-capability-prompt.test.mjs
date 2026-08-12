import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAimForgeSessionPrompt } from '../src/cora/clm-server.mjs';

test('driver prompt names only enabled safety hands', () => {
  const prompt = buildAimForgeSessionPrompt({
    bridgeContext: { surface: 'mobile', role: 'driver' },
    enabledToolNames: ['aimforge_get_equipment_safety_status', 'aimforge_record_equipment_safety_check'],
  });
  assert.match(prompt, /driver mobile session/);
  assert.match(prompt, /read the server-approved equipment-safety workflow/);
  assert.match(prompt, /record one server-manifest-approved/);
  assert.doesNotMatch(prompt, /dispatch-board/);
  assert.doesNotMatch(prompt, /department handoff/);
});

test('empty or disabled policy is spoken honestly', () => {
  const prompt = buildAimForgeSessionPrompt({ bridgeContext: { surface: 'cora', role: 'dispatcher' }, enabledToolNames: [] });
  assert.match(prompt, /No AimForge action hands are enabled/);
  assert.match(prompt, /must not claim to have changed anything/);
});
