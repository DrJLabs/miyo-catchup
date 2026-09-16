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
const setupBinding = Object.freeze({
  binding_id: 'binding-t02-setup', principal_id: binding.principal_id,
  context_id: null, account_id: binding.principal_id,
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

function sessionOnlyFixture(t, options = {}) {
  const root = temporaryRoot(t);
  const time = clockFixture();
  const receiver = createProbeReceiver({
    root, trustedBoundary: root, binding, conversationId,
    clock: time.clock, scope: 'session-only', ownership: () => true,
    validateBody: () => true, ...options,
  });
  t.after(() => receiver.close());
  return { root, receiver, time };
}

function setupInspectionFixture(t, options = {}) {
  const root = temporaryRoot(t);
  const time = clockFixture();
  const receiver = createProbeReceiver({
    root, trustedBoundary: root, binding: setupBinding, conversationId,
    clock: time.clock, scope: 'setup-inspection', ownership: () => true,
    ...options,
  });
  t.after(() => receiver.close());
  return { root, receiver, time };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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
  const claimRequest = makeRequest('claim_work', {
    browser_instance_id: browser, principal_id: null, context_id: null,
  });
  const claim = receiver.request(claimRequest);
  assertReply(claim, 'claim_work');
  const fields = claim.result.lease;
  const fenced = { run_id: fields.run_id, attempt_id: fields.attempt_id, lease_generation: fields.lease_generation };
  const permitRequest = makeRequest('request_permit', { work_unit_id: fields.work_unit }, fenced);
  const permit = receiver.request(permitRequest);
  assertReply(permit, 'request_permit');
  const dispatchRequest = makeRequest('dispatch_started', {
    browser_instance_id: browser, document_id: documentId,
  }, { ...fenced, permit_id: permit.result.permit_id });
  const started = receiver.request(dispatchRequest);
  assertReply(started, 'dispatch_started');
  return {
    fields: fenced, permit: permit.result, documentId,
    requests: { claim: claimRequest, permit: permitRequest, dispatch: dispatchRequest },
  };
}

function sendJson(receiver, transfer, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  return sendBytes(receiver, transfer, bytes);
}

function sendBytes(receiver, transfer, bytes) {
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

test('T02 body preserves valid noncanonical JSON bytes while session remains canonical', (t) => {
  const { receiver, time, root } = receiverFixture(t);
  const session = sessionStart(receiver);
  const sessionRaw = sendJson(receiver, session, { principal_id: binding.principal_id, context_id: binding.context_id });
  assert.equal(commit(receiver, session, sessionRaw.bytes, sessionRaw.digest).ok, true);

  time.value.wall += 10_000;
  time.value.monotonic += 10_000;
  const claim = receiver.request(makeRequest('claim_work', {
    browser_instance_id: browser, principal_id: binding.principal_id, context_id: binding.context_id,
  }));
  const lease = claim.result.lease;
  const fields = { run_id: lease.run_id, attempt_id: lease.attempt_id, lease_generation: lease.lease_generation };
  const permit = receiver.request(makeRequest('request_permit', { work_unit_id: lease.work_unit }, fields));
  const started = receiver.request(makeRequest('dispatch_started', {
    browser_instance_id: browser, document_id: documentId,
  }, { ...fields, permit_id: permit.result.permit_id }));
  assert.equal(started.ok, true);

  const bodyBytes = Buffer.from(`{\n  "conversation_id": "${conversationId}",\n  "messages": [{"role":"user","content":"snow \\u96ea"}]\n}`);
  const body = sendBytes(receiver, { fields, permit: permit.result }, bodyBytes);
  const committed = commit(receiver, { fields, permit: permit.result }, bodyBytes, body.digest);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(receiver.snapshot().sha256, body.digest);
  assert.deepEqual(readFileSync(join(root, 'artifacts', `${committed.result.artifact_id}.json`)), bodyBytes);
});

test('T02 session-only scope commits sanitized session and permanently blocks body work', (t) => {
  const { receiver, root } = sessionOnlyFixture(t);
  const transfer = sessionStart(receiver);
  const sessionRaw = sendJson(receiver, transfer, { principal_id: binding.principal_id, context_id: binding.context_id });
  const sessionCommit = commit(receiver, transfer, sessionRaw.bytes, sessionRaw.digest);
  assert.equal(sessionCommit.ok, true, JSON.stringify(sessionCommit));
  assert.equal(receiver.snapshot().session_committed, true);
  assert.equal(receiver.snapshot().probe_complete, false);
  assert.deepEqual(readFileSync(join(root, 'artifacts', `${sessionCommit.result.artifact_id}.json`)), sessionRaw.bytes);

  const bodyClaim = receiver.request(makeRequest('claim_work', {
    browser_instance_id: browser, principal_id: binding.principal_id, context_id: binding.context_id,
  }));
  assert.deepEqual(bodyClaim.error, { code: 'blocked' });
  const extraSession = receiver.request(makeRequest('claim_work', {
    browser_instance_id: browser, principal_id: null, context_id: null,
  }));
  assert.deepEqual(extraSession.error, { code: 'blocked' });

  const prior = transfer.fields;
  const bodyPermit = receiver.request(makeRequest('request_permit', { work_unit_id: 'body' }, prior));
  assert.deepEqual(bodyPermit.error, { code: 'blocked' });
  const bodyStart = receiver.request(makeRequest('dispatch_started', {
    browser_instance_id: browser, document_id: documentId,
  }, { ...prior, permit_id: transfer.permit.permit_id }));
  assert.deepEqual(bodyStart.error, { code: 'blocked' });
});

test('T02 session-only scope does not require or invoke a body validator', (t) => {
  const root = temporaryRoot(t);
  const time = clockFixture();
  let called = 0;
  const receiver = createProbeReceiver({
    root, trustedBoundary: root, binding, conversationId, clock: time.clock,
    scope: 'session-only', ownership: () => true,
    validateBody: () => { called += 1; return true; },
  });
  t.after(() => receiver.close());
  const transfer = sessionStart(receiver);
  const sessionRaw = sendJson(receiver, transfer, { principal_id: binding.principal_id, context_id: binding.context_id });
  const sessionCommit = commit(receiver, transfer, sessionRaw.bytes, sessionRaw.digest);
  assert.equal(sessionCommit.ok, true, JSON.stringify(sessionCommit));
  assert.equal(called, 0);

  receiver.close();
  const reopened = createProbeReceiver({
    root, trustedBoundary: root, binding, conversationId, scope: 'session-only',
    ownership: () => true,
  });
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().probe_complete, false);
  assert.equal(called, 0);
});

test('T02 setup-inspection commits one observed context without attestation or body promotion', (t) => {
  const { root, receiver } = setupInspectionFixture(t);
  const transfer = sessionStart(receiver);
  const observed = { principal_id: setupBinding.principal_id, context_id: 'observed-context' };
  const sessionRaw = sendJson(receiver, transfer, observed);
  const sessionCommit = commit(receiver, transfer, sessionRaw.bytes, sessionRaw.digest);
  assert.equal(sessionCommit.ok, true, JSON.stringify(sessionCommit));
  const snapshot = receiver.snapshot();
  assert.equal(snapshot.setup_complete, true);
  assert.equal(snapshot.probe_complete, false);
  assert.equal(snapshot.attested, false);
  assert.equal(snapshot.session_committed, true);
  assert.deepEqual(readFileSync(join(root, 'artifacts', `${sessionCommit.result.artifact_id}.json`)), sessionRaw.bytes);
  assert.equal(setupBinding.context_id, null);

  const stateDb = new DatabaseSync(join(root, 'probe-state.db'));
  const stored = JSON.parse(stateDb.prepare('SELECT state FROM probe_state WHERE id = 1').get().state);
  stateDb.close();
  assert.equal(stored.scope, 'setup-inspection');
  assert.equal(stored.attested, false);
  assert.deepEqual(Object.keys(stored.session).sort(), ['artifact_id', 'artifact_path', 'raw_bytes', 'sha256', 'status']);
  assert.notEqual(stored.binding_hash, createHash('sha256').update(canonical(setupBinding)).digest('hex'));

  for (const request of [transfer.requests.claim, transfer.requests.permit, transfer.requests.dispatch,
    makeRequest('claim_work', { browser_instance_id: browser, principal_id: null, context_id: null }),
    makeRequest('request_permit', { work_unit_id: 'session-check' }, transfer.fields),
    makeRequest('dispatch_started', { browser_instance_id: browser, document_id: documentId }, {
      ...transfer.fields, permit_id: transfer.permit.permit_id,
    })]) {
    assert.deepEqual(receiver.request(request).error, { code: 'blocked' });
  }

  receiver.close();
  const reopened = createProbeReceiver({
    root, trustedBoundary: root, binding: setupBinding, conversationId,
    scope: 'setup-inspection', ownership: () => true,
  });
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().setup_complete, true);
  assert.equal(reopened.snapshot().probe_complete, false);
  assert.equal(reopened.snapshot().attested, false);
  assert.deepEqual(reopened.request(transfer.requests.claim).error, { code: 'blocked' });
  assert.deepEqual(reopened.request(makeRequest('claim_work', {
    browser_instance_id: browser, principal_id: null, context_id: null,
  })).error, { code: 'blocked' });
});

test('T02 setup-inspection requires a null context and account-to-principal mapping', (t) => {
  const root = temporaryRoot(t);
  assert.throws(() => createProbeReceiver({
    root, trustedBoundary: root, binding: { ...setupBinding, context_id: 'configured-context' },
    conversationId, scope: 'setup-inspection', ownership: () => true,
  }), /context_id/);
  assert.throws(() => createProbeReceiver({
    root, trustedBoundary: root, binding: { ...setupBinding, account_id: 'other-account' },
    conversationId, scope: 'setup-inspection', ownership: () => true,
  }), /account_id/);
  assert.equal(readdirSync(root).length, 0);
});

test('T02 session transfers must be canonical UTF-8 JSON in every scope', (t) => {
  for (const [scope, scopeBinding, validateBody] of [
    ['conversation', binding, () => true],
    ['session-only', binding, undefined],
    ['setup-inspection', setupBinding, undefined],
  ]) {
    const root = temporaryRoot(t);
    const time = clockFixture();
    const receiver = createProbeReceiver({
      root, trustedBoundary: root, binding: scopeBinding, conversationId, clock: time.clock,
      scope, ownership: () => true, validateBody,
    });
    const transfer = sessionStart(receiver);
    const observedContext = scope === 'setup-inspection' ? 'observed-context' : scopeBinding.context_id;
    const raw = Buffer.from(`{"principal_id":"${scopeBinding.principal_id}","context_id":"${observedContext}","context_id":"${observedContext}"}`);
    const chunk = sendBytes(receiver, transfer, raw);
    const result = commit(receiver, transfer, raw, chunk.digest);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid_body');
    receiver.close();
  }
});

test('T02 session-only scope rejects invalid construction before effects', (t) => {
  const root = temporaryRoot(t);
  let owned = 0;
  for (const scope of ['body-and-session', null]) {
    assert.throws(() => createProbeReceiver({
      scope, root, trustedBoundary: root, binding, conversationId,
      ownership: () => { owned += 1; return true; }, validateBody: () => true,
    }), /scope must be/);
  }
  assert.equal(owned, 0);
  assert.equal(readdirSync(root).length, 0);
});

test('T02 session-only scope remains pinned across restart and rejects conversation reopen', (t) => {
  const { root, receiver } = sessionOnlyFixture(t);
  const transfer = sessionStart(receiver);
  const sessionRaw = sendJson(receiver, transfer, { principal_id: binding.principal_id, context_id: binding.context_id });
  const sessionCommit = commit(receiver, transfer, sessionRaw.bytes, sessionRaw.digest);
  assert.equal(sessionCommit.ok, true, JSON.stringify(sessionCommit));
  const stateDb = new DatabaseSync(join(root, 'probe-state.db'));
  const stored = JSON.parse(stateDb.prepare('SELECT state FROM probe_state WHERE id = 1').get().state);
  stateDb.close();
  assert.equal(stored.scope, 'session-only');
  assert.notEqual(stored.binding_hash, createHash('sha256').update(canonical(binding)).digest('hex'));
  receiver.close();

  assert.throws(() => createProbeReceiver({
    root, trustedBoundary: root, binding, conversationId, ownership: () => true,
    validateBody: () => true, scope: 'conversation',
  }), /scope|binding|conversation/);
  const reopened = createProbeReceiver({
    root, trustedBoundary: root, binding, conversationId, ownership: () => true,
    validateBody: () => true, scope: 'session-only',
  });
  t.after(() => reopened.close());
  const extraSession = reopened.request(makeRequest('claim_work', {
    browser_instance_id: browser, principal_id: null, context_id: null,
  }));
  assert.deepEqual(extraSession.error, { code: 'dispatch_uncertain' });
  const bodyClaim = reopened.request(makeRequest('claim_work', {
    browser_instance_id: browser, principal_id: binding.principal_id, context_id: binding.context_id,
  }));
  assert.deepEqual(bodyClaim.error, { code: 'dispatch_uncertain' });
  const bodyPermit = reopened.request(makeRequest('request_permit', { work_unit_id: 'body' }, transfer.fields));
  assert.deepEqual(bodyPermit.error, { code: 'dispatch_uncertain' });
  const bodyStart = reopened.request(makeRequest('dispatch_started', {
    browser_instance_id: browser, document_id: documentId,
  }, { ...transfer.fields, permit_id: transfer.permit.permit_id }));
  assert.deepEqual(bodyStart.error, { code: 'dispatch_uncertain' });
});

test('T02 legacy conversation roots without a scope field reopen as conversation only', (t) => {
  const { root, receiver } = receiverFixture(t);
  receiver.close();
  const db = new DatabaseSync(join(root, 'probe-state.db'));
  const prior = JSON.parse(db.prepare('SELECT state FROM probe_state WHERE id = 1').get().state);
  delete prior.scope;
  db.prepare('UPDATE probe_state SET state = ? WHERE id = 1').run(JSON.stringify(prior));
  db.close();
  const reopened = createProbeReceiver({ root, trustedBoundary: root, binding, conversationId,
    ownership: () => true, validateBody: () => true });
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().probe_complete, false);
});

test('T02 conversation scope cannot reopen as session-only', (t) => {
  const { root, receiver } = receiverFixture(t);
  receiver.close();
  assert.throws(() => createProbeReceiver({ root, trustedBoundary: root, binding, conversationId,
    scope: 'session-only', ownership: () => true, validateBody: () => true }), /scope|binding|conversation/);
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
