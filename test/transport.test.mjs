import test from 'node:test';
import assert from 'node:assert/strict';
import {
  As2TransportError,
  deliverAs2Outbound,
  selectEffectiveWeight,
} from '../src/core/transport.mjs';

test('summary L3 weight wins over the last AT8 weight', () => {
  assert.equal(selectEffectiveWeight({ l3WeightLbs: 6000, at8WeightLbs: 3500 }), 6000);
});

test('AT8 is a fallback when L3 is absent', () => {
  assert.equal(selectEffectiveWeight({ l3WeightLbs: null, at8WeightLbs: 3500 }), 3500);
  assert.equal(selectEffectiveWeight({ l3WeightLbs: null, at8WeightLbs: null }), null);
});

function repository(events) {
  return {
    async create(value) {
      events.push(['db.create', value.status]);
      return { ...value, id: 41 };
    },
    async update(id, value) {
      events.push(['db.update', value.status]);
      return { id, ...value };
    },
  };
}

test('AS2 transport runs before SENT is persisted', async () => {
  const events = [];
  const result = await deliverAs2Outbound({
    record: { payload: 'ISA...', station: 'partner-a', message_type: '997' },
    repository: repository(events),
    transport: {
      async send() {
        events.push(['network.send']);
        return { status: 200, mdn: { valid: true } };
      },
    },
  });
  assert.equal(result.status, 'SENT');
  assert.deepEqual(events, [
    ['db.create', 'PENDING_RETRY'],
    ['network.send'],
    ['db.update', 'SENT'],
  ]);
});

test('AS2 transport failure never writes SENT', async () => {
  const events = [];
  await assert.rejects(
    deliverAs2Outbound({
      record: { payload: 'ISA...', station: 'partner-a', message_type: '990' },
      repository: repository(events),
      transport: { async send() { throw new Error('connection refused'); } },
    }),
    As2TransportError,
  );
  assert.equal(events.some((event) => event[1] === 'SENT'), false);
  assert.deepEqual(events.at(-1), ['db.update', 'PENDING_RETRY']);
});

test('HTTP 200 without a valid MDN never writes SENT', async () => {
  const events = [];
  await assert.rejects(
    deliverAs2Outbound({
      record: { payload: 'ISA...', station: 'partner-a', message_type: '997' },
      repository: repository(events),
      transport: { async send() { return { status: 200, mdn: null }; } },
    }),
    /not acknowledged/,
  );
  assert.equal(events.some((event) => event[1] === 'SENT'), false);
});
