import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createProbeReceiver } from '../src/probe-receiver.mjs';
import { validateReply } from '../src/contracts.mjs';
import { temporaryRoot } from './helpers/harness.mjs';

const binding = Object.freeze({
  binding_id: 'binding-t02', principal_id: 'principal-t02',
  context_id: 'context-t02', account_id: 'account-t02',
});
const browser = '11111111-1111-4111-8111-111111111111';
const documentId = 'owned-document-1';
const conversationId = 'conversation-t02';

function clockFixture() {
  const value = { wall: 1_800_000_000_000, monotonic: 0, bootId: 'probe-boot' };
  return { value, clock: { read: () => ({ ...value }) } };
}

function makeRequest(operation, payload, fields = {}) {
  return { protocol_version: 1, request_id: randomUUID(), operation, payload, ...fields };
}

function assertReply(value, operation) {
  const validation = validateReply(value, operation);
  assert.equal(validation.ok, true, validation.errors?.join('; '));
  return value;
}

function receiverFixture(t, options = {}) {
  const root = temporaryRoot(t);
  const time = clockFixture();
  const receiver = createProbeReceiver({
    root, trustedBoundary: root, binding, conversationId,
    clock: time.clock,
    ownership: () => true,
    validateBody: (body, expectedId) => body?.conversation_id === expectedId && body?.messages?.length === 1,
    ...options,
  });
  t.after(() => receiver.close());
  return { root, receiver, time };
}

function hello(receiver) {
  const result = receiver.request(makeRequest('hello', {
    extension_version: '1.0.0', browser_instance_id: browser,
    capabilities: ['session_check', 'body', 'chunking'],
  }));
  assertReply(result, 'hello');
}

function sessionStart(receiver) {
  hello(receiver);
  const claim = receiver.request(makeRequest('claim_work', {
    browser_instance_id: browser, principal_id: null, context_id: null,
  }));
  assertReply(claim, 'claim_work');
  const fields = claim.result.lease;
  const fenced = { run_id: fields.run_id, attempt_id: fields.attempt_id, lease_generation: fields.lease_generation };
  const permit = receiver.request(makeRequest('request_permit', { work_unit_id: fields.work_unit }, fenced));
  assertReply(permit, 'request_permit');
  const started = receiver.request(makeRequest('dispatch_started', {
    browser_instance_id: browser, document_id: documentId,
  }, { ...fenced, permit_id: permit.result.permit_id }));
  assertReply(started, 'dispatch_started');
  return { fields: fenced, permit: permit.result, documentId };
}

function sendJson(receiver, transfer, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const data = bytes.toString('base64');
  const chunk = receiver.request(makeRequest('result_chunk', {
    sequence: 0, decoded_bytes: bytes.length, data,
  }, { ...transfer.fields, permit_id: transfer.permit.permit_id }));
  assertReply(chunk, 'result_chunk');
  assert.deepEqual(chunk.result, { next_sequence: 1 });
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

function commit(receiver, transfer, raw, digest) {
  return assertReply(receiver.request(makeRequest('commit_result', {
    chunk_count: 1, raw_bytes: raw.length, sha256: digest,
  }, { ...transfer.fields, permit_id: transfer.permit.permit_id })), 'commit_result');
}

test('T02 positive session then one pinned body preserves exact bytes and reports probe_complete', (t) => {
  const { receiver, time, root } = receiverFixture(t);
  const session = sessionStart(receiver);
  const sessionRaw = sendJson(receiver, session, { principal_id: binding.principal_id, context_id: binding.context_id });
  const sessionCommit = commit(receiver, session, sessionRaw.bytes, sessionRaw.digest);
  assert.equal(sessionCommit.ok, true);
  assert.equal(receiver.snapshot().session_committed, true);

  time.value.wall += 10_000;
  time.value.monotonic += 10_000;
  const claim = receiver.request(makeRequest('claim_work', {
    browser_instance_id: browser, principal_id: binding.principal_id, context_id: binding.context_id,
  }));
  assert.equal(claim.ok, true);
  const fields = claim.result.lease;
  const fenced = { run_id: fields.run_id, attempt_id: fields.attempt_id, lease_generation: fields.lease_generation };
  const permit = receiver.request(makeRequest('request_permit', { work_unit_id: fields.work_unit }, fenced));
  assert.equal(permit.ok, true);
  const started = receiver.request(makeRequest('dispatch_started', {
    browser_instance_id: browser, document_id: documentId,
  }, { ...fenced, permit_id: permit.result.permit_id }));
  assert.equal(started.ok, true);
  const body = sendJson(receiver, { fields: fenced, permit: permit.result }, {
    conversation_id: conversationId, messages: [{ role: 'user', content: 'synthetic' }],
  });
  const bodyCommit = commit(receiver, { fields: fenced, permit: permit.result }, body.bytes, body.digest);
  assert.equal(bodyCommit.ok, true);
  const snapshot = receiver.snapshot();
  assert.equal(snapshot.probe_complete, true);
  assert.equal(snapshot.catalog_complete, false);
  assert.equal(snapshot.verified, false);
  assert.equal(snapshot.raw_bytes, body.bytes.length);
  assert.equal(snapshot.sha256, body.digest);
  const artifact = join(root, 'artifacts', `${bodyCommit.result.artifact_id}.json`);
  assert.deepEqual(readFileSync(artifact), body.bytes);
});

test('T02 persists permit before ACK, enforces expiry and conservative spacing', (t) => {
  const { receiver, time } = receiverFixture(t);
  hello(receiver);
  const claim = receiver.request(makeRequest('claim_work', {
    browser_instance_id: browser, principal_id: null, context_id: null,
  }));
  const fields = claim.result.lease;
  const fenced = { run_id: fields.run_id, attempt_id: fields.attempt_id, lease_generation: fields.lease_generation };
  const permitRequest = makeRequest('request_permit', { work_unit_id: fields.work_unit }, fenced);
  const permit = receiver.request(permitRequest);
  assert.equal(permit.ok, true);
  assert.deepEqual(receiver.request(permitRequest), permit);
  time.value.wall += 5_001;
  const expired = receiver.request(makeRequest('dispatch_started', {
    browser_instance_id: browser, document_id: documentId,
  }, { ...fenced, permit_id: permit.result.permit_id }));
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, 'blocked');
});

test('T02 duplicate and conflicting chunk replays are bounded and fail closed', (t) => {
  const { receiver } = receiverFixture(t);
  const transfer = sessionStart(receiver);
  const raw = Buffer.from(JSON.stringify({ principal_id: binding.principal_id, context_id: binding.context_id }));
  const request = makeRequest('result_chunk', {
    sequence: 0, decoded_bytes: raw.length, data: raw.toString('base64'),
  }, { ...transfer.fields, permit_id: transfer.permit.permit_id });
  const first = receiver.request(request);
  assert.equal(first.ok, true);
  const replay = receiver.request({ ...request, request_id: randomUUID() });
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.result, first.result);
  const changed = receiver.request({ ...request, request_id: randomUUID(), payload: {
    ...request.payload, data: Buffer.from('different').toString('base64'), decoded_bytes: 9,
  } });
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, 'local_conflict');
});

test('T02 rejects unsafe identities, UTF-8/digest mismatches and never accepts session extras', (t) => {
  const { receiver } = receiverFixture(t);
  const transfer = sessionStart(receiver);
  const raw = Buffer.from(JSON.stringify({ principal_id: binding.principal_id, context_id: binding.context_id, token: 'never' }));
  const chunk = receiver.request(makeRequest('result_chunk', {
    sequence: 0, decoded_bytes: raw.length, data: raw.toString('base64'),
  }, { ...transfer.fields, permit_id: transfer.permit.permit_id }));
  assert.equal(chunk.ok, true);
  const rejected = receiver.request(makeRequest('commit_result', {
    chunk_count: 1, raw_bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex'),
  }, { ...transfer.fields, permit_id: transfer.permit.permit_id }));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'identity_mismatch');
  assert.equal(receiver.snapshot().blocker, 'identity_mismatch');
});

test('T02 explicit private roots reject unsafe existing directories', (t) => {
  const root = temporaryRoot(t);
  chmodSync(root, 0o755);
  assert.throws(() => createProbeReceiver({
    root, trustedBoundary: root, binding, conversationId, ownership: () => true, validateBody: () => true,
  }), /mode|unsafe/i);
});

test('T02 reopen of a started or partial permit is persistently dispatch_uncertain', (t) => {
  const { receiver, root } = receiverFixture(t);
  const transfer = sessionStart(receiver);
  const raw = Buffer.from(JSON.stringify({ principal_id: binding.principal_id, context_id: binding.context_id }));
  receiver.request(makeRequest('result_chunk', {
    sequence: 0, decoded_bytes: raw.length, data: raw.toString('base64'),
  }, { ...transfer.fields, permit_id: transfer.permit.permit_id }));
  receiver.close();
  const reopened = createProbeReceiver({
    root, trustedBoundary: root, binding, conversationId, ownership: () => true, validateBody: () => true,
  });
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().blocker, 'dispatch_uncertain');
  const blocked = reopened.request(makeRequest('claim_work', {
    browser_instance_id: browser, principal_id: null, context_id: null,
  }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'dispatch_uncertain');
});

test('T02 completed artifact reopens as probe_complete, while binding changes fail before use', (t) => {
  const { receiver, root, time } = receiverFixture(t);
  const session = sessionStart(receiver);
  const sessionRaw = sendJson(receiver, session, { principal_id: binding.principal_id, context_id: binding.context_id });
  assert.equal(commit(receiver, session, sessionRaw.bytes, sessionRaw.digest).ok, true);
  time.value.wall += 10_000;
  time.value.monotonic += 10_000;
  const claim = receiver.request(makeRequest('claim_work', {
    browser_instance_id: browser, principal_id: binding.principal_id, context_id: binding.context_id,
  }));
  const lease = claim.result.lease;
  const fenced = { run_id: lease.run_id, attempt_id: lease.attempt_id, lease_generation: lease.lease_generation };
  const permit = receiver.request(makeRequest('request_permit', { work_unit_id: lease.work_unit }, fenced));
  receiver.request(makeRequest('dispatch_started', { browser_instance_id: browser, document_id: documentId }, {
    ...fenced, permit_id: permit.result.permit_id,
  }));
  const body = sendJson(receiver, { fields: fenced, permit: permit.result }, {
    conversation_id: conversationId, messages: [{ role: 'user', content: 'reopen' }],
  });
  const commitRequest = makeRequest('commit_result', {
    chunk_count: 1, raw_bytes: body.bytes.length, sha256: body.digest,
  }, { ...fenced, permit_id: permit.result.permit_id });
  const committed = receiver.request(commitRequest);
  assert.equal(committed.ok, true);
  receiver.close();
  const reopened = createProbeReceiver({
    root, trustedBoundary: root, binding, conversationId, ownership: () => true,
    validateBody: () => true,
  });
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().probe_complete, true);
  assert.deepEqual(reopened.request(commitRequest), committed);
  // Remove only the generated artifact inside this test's isolated root.
  unlinkSync(join(root, 'artifacts', `${committed.result.artifact_id}.json`));
  reopened.close();
  const missing = createProbeReceiver({ root, trustedBoundary: root, binding, conversationId,
    ownership: () => true, validateBody: () => true });
  assert.equal(missing.snapshot().blocker, 'recovery_evidence_missing');
  assert.deepEqual(missing.request(commitRequest), { protocol_version: 1,
    request_id: commitRequest.request_id, ok: false, error: { code: 'recovery_evidence_missing' } });
  missing.close();
  assert.throws(() => createProbeReceiver({
    root, trustedBoundary: root, binding: { ...binding, context_id: 'changed-context' },
    conversationId, ownership: () => true, validateBody: () => true,
  }), /binding|conversation/i);
});

test('T02 clock discontinuity, boot change and monotonic expiry block dispatch', (t) => {
  for (const mutate of [
    (value) => { value.bootId = 'changed-boot'; },
    (value) => { value.wall -= 1; value.monotonic += 10000; },
    (value) => { value.wall += 61000; },
    (value) => { value.monotonic += 10000; },
  ]) {
    const { receiver, time } = receiverFixture(t);
    const claim = receiver.request(makeRequest('claim_work', {
      browser_instance_id: browser, principal_id: null, context_id: null,
    }));
    const lease = claim.result.lease;
    const fence = { run_id: lease.run_id, attempt_id: lease.attempt_id, lease_generation: lease.lease_generation };
    const permit = receiver.request(makeRequest('request_permit', { work_unit_id: lease.work_unit }, fence));
    mutate(time.value);
    const result = receiver.request(makeRequest('dispatch_started', {
      browser_instance_id: browser, document_id: documentId,
    }, { ...fence, permit_id: permit.result.permit_id }));
    assert.equal(result.ok, false);
    assert.ok(['clock_untrusted', 'dispatch_uncertain'].includes(receiver.snapshot().blocker));
  }
});

test('T02 persists the longest Retry-After deadline and never reopens a failed probe', (t) => {
  for (const [retryAfter, duration, unbounded] of [['86400', 86400000, false],
    ['invalid', 3600000, false], ['9'.repeat(128), 3600000, true]]) {
    const { receiver, time, root } = receiverFixture(t);
    const transfer = sessionStart(receiver);
    const failure = makeRequest('request_failed', { failure_class: 'rate_limited', http_status: 429,
      retry_after: retryAfter }, { ...transfer.fields, permit_id: transfer.permit.permit_id });
    assert.equal(receiver.request(failure).ok, true);
    assert.equal(receiver.snapshot().retry_at, unbounded ? null : new Date(time.value.wall + duration).toISOString());
    assert.equal(receiver.snapshot().cooldown_unbounded, unbounded);
    receiver.close();
    const reopened = createProbeReceiver({ root, trustedBoundary: root, binding, conversationId,
      ownership: () => true, validateBody: () => true, clock: time.clock });
    t.after(() => reopened.close());
    assert.equal(reopened.snapshot().retry_at, unbounded ? null : new Date(time.value.wall + duration).toISOString());
    assert.equal(reopened.snapshot().blocker, 'cooldown');
    assert.equal(reopened.snapshot().cooldown_unbounded, unbounded);
    assert.equal(reopened.request(makeRequest('claim_work', {
      browser_instance_id: browser, principal_id: null, context_id: null,
    })).ok, false);
  }
});

test('T02 receipt transaction failure never ACKs or permits repeated artifact allocation', (t) => {
  const { receiver, root, time } = receiverFixture(t);
  const session = sessionStart(receiver);
  const sessionRaw = sendJson(receiver, session, { principal_id: binding.principal_id, context_id: binding.context_id });
  assert.equal(commit(receiver, session, sessionRaw.bytes, sessionRaw.digest).ok, true);
  time.value.wall += 10000; time.value.monotonic += 10000;
  const claim = receiver.request(makeRequest('claim_work', {
    browser_instance_id: browser, principal_id: binding.principal_id, context_id: binding.context_id,
  }));
  const lease = claim.result.lease;
  const fields = { run_id: lease.run_id, attempt_id: lease.attempt_id, lease_generation: lease.lease_generation };
  const permit = receiver.request(makeRequest('request_permit', { work_unit_id: lease.work_unit }, fields));
  receiver.request(makeRequest('dispatch_started', { browser_instance_id: browser, document_id: documentId },
    { ...fields, permit_id: permit.result.permit_id }));
  const body = sendJson(receiver, { fields, permit: permit.result }, {
    conversation_id: conversationId, messages: [{ role: 'user', content: 'synthetic fault' }],
  });
  // Inject failure only into this test's generated DB, after artifact fsync but
  // before the state+receipt transaction can commit. No production DB exists.
  const fixtureDb = new DatabaseSync(join(root, 'probe-state.db'));
  fixtureDb.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON request_receipts
    BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END`);
  fixtureDb.close();
  assert.throws(() => commit(receiver, { fields, permit: permit.result }, body.bytes, body.digest), /synthetic receipt failure/);
  assert.equal(receiver.snapshot().probe_complete, false);
  const files = readdirSync(join(root, 'artifacts'));
  assert.equal(files.length, 2); // session plus preserved, unacknowledged body
  assert.throws(() => commit(receiver, { fields, permit: permit.result }, body.bytes, body.digest), /requires restart/);
  assert.deepEqual(readdirSync(join(root, 'artifacts')), files);
  receiver.close();
  const reopened = createProbeReceiver({ root, trustedBoundary: root, binding, conversationId,
    ownership: () => true, validateBody: () => true, clock: time.clock });
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().probe_complete, false);
  assert.equal(reopened.snapshot().blocker, 'dispatch_uncertain');
});
