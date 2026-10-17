// logLines bridge identity: bridge posts (authorKind='agent', subject ending
// in ':bridge') render as the BRIDGE_DISPLAY_NAME instead of generic "agent".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logLines, BRIDGE_DISPLAY_NAME } from '../web/marketing/app/app-model.mjs';

const SUBJECT = 'user_abc123';

test('bridge messages get the bridge display name, not "agent"', () => {
  const lines = logLines({ messages: [
    { id: '1', authorKind: 'agent', authorSubject: `${SUBJECT}:bridge`, body: 'hello', createdAt: '2026-10-17T08:00:00Z' },
  ] }, SUBJECT);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].who, BRIDGE_DISPLAY_NAME);
  assert.equal(lines[0].who, 'Maestro');
  assert.equal(lines[0].bridge, true);
  assert.equal(lines[0].mine, false, 'bridge reply is not mine, so voice speaks it');
});

test('non-bridge agent messages keep the old fallback', () => {
  const lines = logLines({ messages: [
    { id: '2', authorKind: 'agent', authorSubject: 'someone-else', body: 'hi' },
    { id: '3', authorKind: 'agent', authorSubject: 'someone-else', authorName: 'Helper', body: 'hi' },
  ] }, SUBJECT);
  assert.equal(lines[0].who, 'agent');
  assert.equal(lines[0].bridge, false);
  assert.equal(lines[1].who, 'Helper');
  assert.equal(lines[1].bridge, false);
});

test('human messages are unchanged', () => {
  const lines = logLines({ messages: [
    { id: '4', authorKind: 'human', authorSubject: SUBJECT, body: 'yo' },
    { id: '5', authorKind: 'human', authorSubject: 'user_other', body: 'hey' },
  ] }, SUBJECT);
  assert.equal(lines[0].who, 'you');
  assert.equal(lines[0].mine, true);
  assert.equal(lines[1].who, 'member');
  assert.equal(lines[1].mine, false);
});

test('a human subject that happens to end in :bridge is not renamed', () => {
  const lines = logLines({ messages: [
    { id: '6', authorKind: 'human', authorSubject: 'weird:bridge', body: 'x' },
  ] }, SUBJECT);
  assert.equal(lines[0].who, 'member');
  assert.equal(lines[0].bridge, false);
});
