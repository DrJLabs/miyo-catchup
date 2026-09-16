import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnectionCheckReceiver, CONNECTION_CHECK_WORKER_VERSION } from '../src/connection-check.mjs';
import { assertReply, assertStatus, validateRequest } from '../src/contracts.mjs';

function request(operation, payload = {}) {
  return { protocol_version: 1, request_id: randomUUID(), operation, payload };
}

test('connection receiver answers only global get_status with current blocked status', () => {
  const now = 1_800_000_000_000;
  const receiver = createConnectionCheckReceiver({ now: () => now });
  const message = request('get_status');
  const reply = receiver.handle(message);
  assertReply(reply, 'get_status');
  assert.equal(reply.ok, true);
  assert.equal(reply.request_id, message.request_id);
  assertStatus(reply.result.status);
  assert.match(reply.result.status.worker_instance_id, /^[0-9a-f-]{36}$/);
  assert.equal(reply.result.status.worker_version, CONNECTION_CHECK_WORKER_VERSION);
  assert.equal(reply.result.status.generated_at, '2027-01-15T08:00:00.000Z');
  assert.equal(reply.result.status.heartbeat_at, reply.result.status.generated_at);
  assert.equal(reply.result.status.connectivity, 'available');
  assert.equal(reply.result.status.liveness, 'live');
  assert.deepEqual(reply.result.status.blockers, ['blocked']);
  assert.equal(reply.result.status.primary_blocker, 'blocked');
  assert.equal(reply.result.status.error_code, 'blocked');
  assert.equal(reply.result.status.run, null);
  for (const key of ['last_complete_scan', 'last_fully_verified_run', 'receipt_evidence_at',
    'next_scheduled_due_at', 'cooldown_until', 'retry_at']) assert.equal(reply.result.status[key], null);
  assert.deepEqual(reply.result.status.budget_remaining, {
    session_requests: 0, catalog_pages: 0, body_requests: 0, total_requests: 0, attempts: 0,
  });
  assert.equal(receiver.requestCount, 1);
});

test('connection receiver refreshes heartbeat and keeps one worker identity', () => {
  let now = 1_800_000_000_000;
  const receiver = createConnectionCheckReceiver({ now: () => now });
  const first = receiver.request(request('get_status'));
  now += 1000;
  const second = receiver.request(request('get_status'));
  assert.notEqual(first.result.status.generated_at, second.result.status.generated_at);
  assert.equal(first.result.status.worker_instance_id, second.result.status.worker_instance_id);
});

test('valid non-status operations and scoped status are refused without effects', () => {
  const receiver = createConnectionCheckReceiver();
  const cases = [
    request('hello', { extension_version: '0.0.0', browser_instance_id: randomUUID(), capabilities: [] }),
    request('get_status', { run_id: randomUUID() }),
    request('request_run', { trigger_type: 'popup', mode: 'dry_run', idempotency_key: randomUUID() }),
  ];
  for (const message of cases) {
    assert.equal(validateRequest(message).ok, true);
    const reply = receiver.request(message);
    assertReply(reply, message.operation);
    assert.deepEqual(reply, {
      protocol_version: 1, request_id: message.request_id, ok: false, error: { code: 'blocked' },
    });
  }
  assert.equal(receiver.requestCount, cases.length);
});

test('invalid requests fail contract validation before any response', () => {
  const receiver = createConnectionCheckReceiver();
  const invalid = request('get_status', { token: 'synthetic-secret' });
  assert.equal(validateRequest(invalid).ok, false);
  assert.throws(() => receiver.request(invalid));
  assert.equal(receiver.requestCount, 0);
});
