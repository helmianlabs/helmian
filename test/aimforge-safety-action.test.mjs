import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  AIMFORGE_EQUIPMENT_SAFETY_CHECK_PATH,
  AIMFORGE_EQUIPMENT_SAFETY_CHECK_TOOL_NAME,
  AIMFORGE_EQUIPMENT_SAFETY_ESCALATION_PATH,
  AIMFORGE_EQUIPMENT_SAFETY_ESCALATION_TOOL_NAME,
  AIMFORGE_EQUIPMENT_SAFETY_STATUS_PATH,
  AIMFORGE_EQUIPMENT_SAFETY_STATUS_TOOL_NAME,
  AIMFORGE_EQUIPMENT_SAFETY_TOOL_NAMES,
  createAimForgeBoardActionClient,
  createAimForgeBoardToolRuntime,
} from '../src/cora/aimforge-board-action.mjs';

const secret = 'a'.repeat(40);
const bridge = 'helmion:signed.bridge';
const receipt = 'b'.repeat(32);
const uuid = '123e4567-e89b-42d3-a456-426614174000';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-aimforge-action-receipt': receipt } });
}

function client(fetchImpl) {
  return createAimForgeBoardActionClient({ baseUrl: 'https://aimforge-api.fly.dev', actionSecret: secret,
    fetchImpl, now: () => new Date('2026-08-11T12:00:00Z'), nonce: () => 'nonce_nonce_nonce_1234' });
}

test('safety client signs only fixed paths and exposes no scope arguments', async () => {
  const calls = [];
  const c = client(async (url, init) => {
    calls.push({ url: String(url), init });
    const path = new URL(url).pathname;
    if (path === AIMFORGE_EQUIPMENT_SAFETY_STATUS_PATH) return jsonResponse({
      version: '1', action: 'equipment.safety.status', state: 'active', disposition: 'PENDING', equipmentType: 'dry_van',
      workflowVersion: '1', guidanceVersion: '1', guidanceDisclaimer: 'Driver remains responsible.', guidanceCitations: ['49 CFR 392.7'], checks: [], recordedChecks: [],
    });
    if (path === AIMFORGE_EQUIPMENT_SAFETY_CHECK_PATH) return jsonResponse({ version: '1', action: 'equipment.safety.check', state: 'recorded', disposition: 'PENDING', inspectionItemId: uuid }, 201);
    return jsonResponse({ version: '1', action: 'equipment.safety.escalation', state: 'supervisor_review_requested', disposition: 'HOLD', inspectionItemId: uuid }, 201);
  });
  await c.getEquipmentSafetyStatus({ signedBridge: bridge });
  await c.recordEquipmentSafetyCheck({ signedBridge: bridge, checkKey: 'brakes', result: 'OK', notes: null, structuredData: {} });
  await c.requestSafetySupervisorReview({ signedBridge: bridge, checkKey: 'brakes', reason: 'Uncertain pedal travel' });
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [AIMFORGE_EQUIPMENT_SAFETY_STATUS_PATH, AIMFORGE_EQUIPMENT_SAFETY_CHECK_PATH, AIMFORGE_EQUIPMENT_SAFETY_ESCALATION_PATH]);
  for (const call of calls) {
    const body = JSON.parse(call.init.body);
    for (const forbidden of ['tenantId', 'assignmentId', 'driverId', 'profile', 'citation', 'provider', 'url']) assert.equal(Object.hasOwn(body, forbidden), false);
    const canonical = ['v1', 'POST', new URL(call.url).pathname, call.init.headers['x-helmian-timestamp'], call.init.headers['x-helmian-nonce'],
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(call.init.body)).then((bytes) => Buffer.from(bytes).toString('hex'))].join('\n');
    assert.equal(call.init.headers['x-helmian-signature'], createHmac('sha256', secret).update(canonical).digest('base64url'));
    assert.equal(call.init.redirect, 'error');
  }
});

test('driver runtime advertises exactly three safety hands and no release/approve/generic tool', () => {
  const c = { getDispatchBoardSummary() {}, prepareDriverMessage() {}, createDepartmentHandoff() {},
    getEquipmentSafetyStatus() {}, recordEquipmentSafetyCheck() {}, requestSafetySupervisorReview() {} };
  const runtime = createAimForgeBoardToolRuntime({ client: c, signedBridge: bridge, enabledToolNames: AIMFORGE_EQUIPMENT_SAFETY_TOOL_NAMES });
  assert.deepEqual(Object.keys(runtime.tools), [AIMFORGE_EQUIPMENT_SAFETY_STATUS_TOOL_NAME, AIMFORGE_EQUIPMENT_SAFETY_CHECK_TOOL_NAME, AIMFORGE_EQUIPMENT_SAFETY_ESCALATION_TOOL_NAME]);
  assert.equal(Object.keys(runtime.tools).some((name) => /release|approve|send|http|shell|hazmat/iu.test(name)), false);
  for (const definition of runtime.definitionsForOpenAi()) {
    const props = Object.keys(definition.function.parameters.properties ?? {});
    for (const forbidden of ['tenantId', 'assignmentId', 'driverId', 'profile', 'citations', 'provider', 'url']) assert.equal(props.includes(forbidden), false);
  }
});

test('safety input rejects forged scope/evidence and escalation accepts only check/reason', async () => {
  const c = { getDispatchBoardSummary() {}, prepareDriverMessage() {}, createDepartmentHandoff() {},
    getEquipmentSafetyStatus: async () => ({}), recordEquipmentSafetyCheck: async () => ({}), requestSafetySupervisorReview: async () => ({}) };
  const runtime = createAimForgeBoardToolRuntime({ client: c, signedBridge: bridge, enabledToolNames: AIMFORGE_EQUIPMENT_SAFETY_TOOL_NAMES });
  assert.match(await runtime.execute(AIMFORGE_EQUIPMENT_SAFETY_CHECK_TOOL_NAME,
    { checkKey: 'brakes', result: 'OK', notes: null, structuredData: {}, assignmentId: 9 }), /Only checkKey/iu);
  assert.match(await runtime.execute(AIMFORGE_EQUIPMENT_SAFETY_CHECK_TOOL_NAME,
    { checkKey: 'brakes', result: 'DEFECT_OOS', notes: 'bad', structuredData: {}, evidence: [] }), /Only checkKey/iu);
  assert.match(await runtime.execute(AIMFORGE_EQUIPMENT_SAFETY_ESCALATION_TOOL_NAME,
    { checkKey: 'brakes', reason: 'help', tenantId: 'other' }), /Only checkKey/iu);
});

test('client never turns a refused evidence/hazmat/hold response into spoken success', async () => {
  for (const [code, invoke] of [
    ['EVIDENCE_REQUIRED', (c) => c.recordEquipmentSafetyCheck({ signedBridge: bridge, checkKey: 'tires', result: 'DEFECT_MAJOR', notes: 'cut', structuredData: {} })],
    ['HAZMAT_PROFILE_UNAVAILABLE', (c) => c.getEquipmentSafetyStatus({ signedBridge: bridge })],
    ['INSPECTION_NOT_ACTIVE', (c) => c.recordEquipmentSafetyCheck({ signedBridge: bridge, checkKey: 'brakes', result: 'OK', notes: null, structuredData: {} })],
  ]) {
    const c = client(async () => jsonResponse({ error: 'refused', code }, code === 'EVIDENCE_REQUIRED' ? 422 : 409));
    await assert.rejects(invoke(c), /refused/iu);
  }
});
