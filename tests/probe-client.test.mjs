import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createNativeClient, ProbeClientError, runProbe, runSessionCheck, runSetupInspection,
  runBackgroundSetupInspection, runBackgroundSelectedProbe } from '../extension/probe-client.mjs';
import { assertReply, assertRequest, MAX_RAW_CHUNK_BYTES } from '../src/contracts.mjs';

const binding = { principal_id: 'synthetic-user', context_id: 'synthetic-personal' };
const browserInstanceId = randomUUID();
const documentId = 'synthetic-document';

function selectedFixture(overrides = {}) {
  const fixture = syntheticProbe(overrides);
  fixture.options.collector = { ...fixture.options.page, collectorInstanceId: randomUUID() };
  delete fixture.options.collector.documentId;
  delete fixture.options.page;
  return fixture;
}

test('selected client uses background identity and two independently acknowledged permits', async () => {
  const f = selectedFixture();
  const result = await runBackgroundSelectedProbe(f.options);
  assert.equal(result.state, 'background_probe_complete');
  assert.equal(result.receipts.length, 2);
  assert.deepEqual(f.messages[0].payload.capabilities,
    ['session_check', 'body', 'chunking', 'background_session_check', 'background_selected_body']);
  for (const m of f.messages.filter((m) => m.operation === 'dispatch_started')) {
    assert.equal(m.payload.collector_instance_id, f.options.collector.collectorInstanceId);
    assert.equal(Object.hasOwn(m.payload, 'document_id'), false);
  }
  assert.deepEqual(f.waits, [10000]);
});

test('selected lost session/body dispatch or commit ACK aborts without another dispatch or retry', async () => {
  for (const [operation, occurrence, expectedDispatches] of [
    ['dispatch_started', 1, 0], ['commit_result', 1, 1],
    ['dispatch_started', 2, 1], ['commit_result', 2, 2],
  ]) {
    const f = selectedFixture();
    let count = 0;
    const request = f.options.request;
    f.options.request = async (m) => {
      const reply = await request(m);
      if (m.operation === operation && ++count === occurrence) throw new Error('private-transport-detail');
      return reply;
    };
    await assert.rejects(runBackgroundSelectedProbe(f.options), { code: 'dispatch_uncertain' });
    assert.equal(f.pageCalls.filter((op) => op === 'dispatch').length, expectedDispatches);
    assert.equal(f.pageCalls.at(-1), 'abort');
    assert.equal(f.messages.filter((m) => m.operation === operation).length, occurrence);
  }
});

test('selected client rejects a changed session context before any native data or body claim', async () => {
  const f = selectedFixture();
  const call = f.options.collector.call;
  f.options.collector.call = async (command) => {
    const result = await call(command);
    if (command.operation !== 'pull') return result;
    const bytes = Buffer.from(JSON.stringify({ ...binding, context_id: 'other-personal' }));
    return { ...result, decoded_bytes: bytes.length, data: bytes.toString('base64') };
  };
  await assert.rejects(runBackgroundSelectedProbe(f.options), { code: 'invalid_probe_message' });
  assert.equal(f.messages.some((m) => m.operation === 'result_chunk'), false);
  assert.equal(f.pageCalls.filter((op) => op === 'dispatch').length, 1);
});

function syntheticProbe({ loseCommit = false, failure, poison = false, setup = false } = {}) {
  const probeBinding = setup ? { principal_id: 'setup-principal', context_id: null } : binding;
  const setupOutcome = { principal_id: probeBinding.principal_id, context_id: 'setup-context' };
  const messages = [];
  const pageCalls = [];
  const stored = [];
  const waits = [];
  const lease = { run_id: randomUUID(), attempt_id: randomUUID(), lease_generation: 1,
    lease_expires_at: '2027-01-01T00:00:00.000Z', work_unit: 'synthetic-session' };
  let kind = 'session_check';
  let bytes;
  let permitId;
  const request = async (message) => {
    assertRequest(message);
    messages.push(structuredClone(message));
    let result;
    switch (message.operation) {
      case 'hello': result = { worker_instance_id: randomUUID(), protocol_version: 1, config_version: 1 }; break;
      case 'claim_work':
        kind = message.payload.principal_id === null ? 'session_check' : 'body';
        lease.work_unit = `synthetic-${kind}`;
        result = { lease: { ...lease } }; break;
      case 'request_permit':
        permitId = randomUUID();
        result = { granted: true, permit_id: permitId, request_kind: kind,
          arguments: kind === 'session_check' ? {} : { conversation_ids: ['synthetic-conversation'] },
          valid_until: '2027-01-01T00:00:00.000Z' }; break;
      case 'dispatch_started': result = { accepted: true }; break;
      case 'result_chunk': result = { next_sequence: message.payload.sequence + 1 }; break;
      case 'commit_result':
        if (loseCommit) throw new Error('private-raw-error-sentinel');
        result = { artifact_id: randomUUID(), raw_bytes: message.payload.raw_bytes, sha256: message.payload.sha256 }; break;
      case 'request_failed': result = { recorded: true }; break;
      default: assert.fail('unexpected operation');
    }
    const reply = { protocol_version: 1, request_id: message.request_id, ok: true, result };
    assertReply(reply, message.operation);
    return reply;
  };
  const page = { documentId, async call(command) {
    pageCalls.push(command.operation);
    switch (command.operation) {
      case 'dispatch':
        assert.equal(messages.at(-1).operation, 'dispatch_started');
        assert.equal(command.permit.permit_id, permitId);
        if (failure) return { ok: false, error: failure };
        bytes = Buffer.from(kind === 'session_check' ? JSON.stringify(setup ? setupOutcome : binding)
          : JSON.stringify({ conversation: { id: 'synthetic-conversation', text: 'λ🌲'.repeat(60000) } }));
        return { ok: true, raw_bytes: bytes.length, chunk_count: Math.ceil(bytes.length / MAX_RAW_CHUNK_BYTES),
          sha256: createHash('sha256').update(bytes).digest('hex'), ...(poison ? { token: 'secret-sentinel' } : {}) };
      case 'pull': {
        const chunk = bytes.subarray(command.sequence * MAX_RAW_CHUNK_BYTES, (command.sequence + 1) * MAX_RAW_CHUNK_BYTES);
        return { ok: true, sequence: command.sequence, decoded_bytes: chunk.length, data: chunk.toString('base64') };
      }
      case 'release': case 'abort': return { ok: true };
      default: assert.fail('unexpected page operation');
    }
  } };
  return { messages, pageCalls, stored, waits, options: { request, page, binding: probeBinding, browserInstanceId,
    conversationId: 'synthetic-conversation',
    wait: async (ms) => waits.push(ms), persistFailure: async (value) => stored.push(structuredClone(value)) } };
}

test('AC01/AC06/AC13: separately permitted session/body, sequential exact bounded chunks, probe-only completion', async () => {
  const fixture = syntheticProbe();
  const result = await runProbe(fixture.options);
  assert.equal(result.state, 'probe_complete');
  assert.equal(result.receipts.length, 2);
  assert.deepEqual(fixture.waits, [10000]);
  assert.deepEqual(fixture.messages.filter((message) => message.operation === 'request_permit')
    .map((message) => message.payload.work_unit_id), ['synthetic-session_check', 'synthetic-body']);
  assert.ok(fixture.messages.every((message) => Buffer.byteLength(JSON.stringify(message)) <= 262144));
  assert.equal(fixture.pageCalls.at(-1), 'abort');
  assert.equal(fixture.messages.filter((message) => message.operation === 'commit_result').length, 2);
  assert.ok(!fixture.messages.some((message) => ['request_run', 'verify', 'resume'].includes(message.operation)));
});

test('AC06: lost durable ACK stops without body fetch, retry or completion', async () => {
  const fixture = syntheticProbe({ loseCommit: true });
  await assert.rejects(runProbe(fixture.options), { code: 'dispatch_uncertain', message: 'dispatch_uncertain' });
  assert.equal(fixture.pageCalls.filter((op) => op === 'dispatch').length, 1);
  assert.equal(fixture.messages.filter((message) => message.operation === 'commit_result').length, 1);
  assert.equal(fixture.pageCalls.at(-1), 'abort');
});

test('AC01: page controls with extra secret fields are rejected before native forwarding', async () => {
  const fixture = syntheticProbe({ poison: true });
  await assert.rejects(runProbe(fixture.options), { code: 'invalid_probe_message' });
  assert.ok(!JSON.stringify(fixture.messages).includes('secret-sentinel'));
  assert.equal(fixture.messages.filter((message) => message.operation === 'result_chunk').length, 0);
});

test('AC06: sanitized 429 failure is persisted before forwarding; no new permits', async () => {
  const failure = { failure_class: 'rate_limited', http_status: 429, retry_after: '3601' };
  const fixture = syntheticProbe({ failure });
  const original = fixture.options.request;
  fixture.options.request = async (request) => {
    if (request.operation === 'request_failed') assert.equal(fixture.stored.length, 1);
    return original(request);
  };
  await assert.rejects(runProbe(fixture.options), { code: 'probe_failed' });
  assert.deepEqual(fixture.stored[0].payload, failure);
  assert.equal(fixture.messages.filter((message) => message.operation === 'request_permit').length, 1);
});

test('session-only qualification advertises and dispatches only one session, then aborts the page', async () => {
  const fixture = syntheticProbe();
  delete fixture.options.conversationId;
  const result = await runSessionCheck(fixture.options);
  assert.equal(result.state, 'session_check_complete');
  assert.equal(result.receipts.length, 1);
  assert.deepEqual(fixture.messages[0].payload.capabilities, ['session_check', 'chunking']);
  const claims = fixture.messages.filter((message) => message.operation === 'claim_work');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].payload.principal_id, null);
  assert.equal(claims[0].payload.context_id, null);
  assert.equal(fixture.messages.filter((message) => message.operation === 'request_permit').length, 1);
  assert.equal(fixture.messages.filter((message) => message.operation === 'commit_result').length, 1);
  assert.deepEqual(fixture.pageCalls, ['dispatch', 'pull', 'release', 'abort']);
  assert.deepEqual(fixture.waits, []);
});

test('setup inspection accepts a discovered context and never requests body work', async () => {
  const fixture = syntheticProbe({ setup: true });
  delete fixture.options.conversationId;
  let released = false;
  const pageCall = fixture.options.page.call;
  fixture.options.page.call = async (command) => {
    if (command.operation === 'release') released = true;
    return pageCall(command);
  };
  const request = fixture.options.request;
  fixture.options.request = async (message) => {
    if (message.operation === 'commit_result') assert.equal(released, true);
    return request(message);
  };
  const result = await runSetupInspection(fixture.options);
  assert.equal(result.state, 'setup_inspection_complete');
  assert.equal(result.receipts.length, 1);
  assert.deepEqual(fixture.messages[0].payload.capabilities, ['session_check', 'chunking']);
  assert.equal(fixture.messages.filter((message) => message.operation === 'claim_work').length, 1);
  assert.equal(fixture.messages.filter((message) => message.operation === 'request_permit').length, 1);
  assert.deepEqual(fixture.pageCalls, ['dispatch', 'pull', 'release', 'abort']);
  assert.equal(fixture.waits.length, 0);
});

function backgroundFixture(overrides = {}) {
  const fixture = syntheticProbe({ setup: true, ...overrides });
  fixture.options.collector = { collectorInstanceId: randomUUID(), call: fixture.options.page.call };
  delete fixture.options.page;
  return fixture;
}

const failureRoutes = [
  [runProbe, syntheticProbe],
  [runSessionCheck, syntheticProbe],
  [runSetupInspection, (options) => syntheticProbe({ setup: true, ...options })],
  [runBackgroundSetupInspection, backgroundFixture],
  [runBackgroundSelectedProbe, selectedFixture],
];
const rateLimited = { failure_class: 'rate_limited', http_status: 429, retry_after: '3601' };

test('AC06: failure recording requires a positive, correlated, exact native ACK on every route', async () => {
  const invalidAcks = [
    (reply) => ({ protocol_version: 1, request_id: reply.request_id, ok: false,
      error: { code: 'invalid_request' } }),
    (reply) => ({ ...reply, result: {} }),
    (reply) => ({ ...reply, result: { recorded: false } }),
    (reply) => ({ ...reply, result: { recorded: true, unexpected: true } }),
    (reply) => ({ ...reply, request_id: randomUUID() }),
    (reply) => ({ ...reply, protocol_version: 2 }),
    (reply) => ({ ...reply, error: { code: 'invalid_request' } }),
    () => null,
    () => { throw new Error('private-transport-detail'); },
    () => { throw new ProbeClientError('invalid_probe_message'); },
  ];
  for (const [run, makeFixture] of failureRoutes) {
    for (const invalidAck of invalidAcks) {
      const f = makeFixture({ failure: rateLimited });
      const request = f.options.request;
      f.options.request = async (message) => {
        if (message.operation === 'request_failed') assert.deepEqual(f.stored, [message]);
        const reply = await request(message);
        return message.operation === 'request_failed' ? invalidAck(reply) : reply;
      };
      await assert.rejects(run(f.options), { code: 'dispatch_uncertain' });
      assert.deepEqual(f.stored, f.messages.filter((m) => m.operation === 'request_failed'));
      assert.equal(f.stored.length, 1);
      assert.deepEqual(f.stored[0].payload, rateLimited);
      assert.equal(f.messages.filter((m) => m.operation === 'request_permit').length, 1);
      assert.deepEqual(f.pageCalls, ['dispatch', 'abort']);
      assert.equal(f.messages.some((m) => ['result_chunk', 'commit_result'].includes(m.operation)), false);
    }
  }
});

test('AC06: only an acknowledged failure reports probe_failed, without retrying or replacing its receipt', async () => {
  for (const [run, makeFixture] of failureRoutes) {
    const f = makeFixture({ failure: rateLimited });
    await assert.rejects(run(f.options), { code: 'probe_failed' });
    assert.deepEqual(f.stored, f.messages.filter((m) => m.operation === 'request_failed'));
    assert.equal(f.stored.length, 1);
    assert.equal(f.messages.filter((m) => m.operation === 'request_permit').length, 1);
    assert.deepEqual(f.pageCalls, ['dispatch', 'abort']);
  }
});

test('background setup uses a distinct capability and collector identity with one permit', async () => {
  const fixture = backgroundFixture();
  const result = await runBackgroundSetupInspection(fixture.options);
  assert.equal(result.state, 'background_setup_inspection_complete');
  assert.equal(result.receipts.length, 1);
  assert.deepEqual(fixture.messages[0].payload.capabilities,
    ['session_check', 'chunking', 'background_session_check']);
  assert.deepEqual(fixture.messages.find((message) => message.operation === 'dispatch_started').payload,
    { browser_instance_id: browserInstanceId, collector_instance_id: fixture.options.collector.collectorInstanceId });
  assert.deepEqual(fixture.pageCalls, ['dispatch', 'pull', 'release', 'abort']);
  assert.equal(fixture.messages.filter((message) => message.operation === 'request_permit').length, 1);
  assert.deepEqual(fixture.waits, []);
});

test('background setup never dispatches after a lost dispatch ACK and never retries a lost commit', async () => {
  for (const lostOperation of ['dispatch_started', 'commit_result']) {
    const fixture = backgroundFixture();
    const request = fixture.options.request;
    fixture.options.request = async (message) => {
      const reply = await request(message);
      if (message.operation === lostOperation) throw new Error('private-transport-sentinel');
      return reply;
    };
    await assert.rejects(runBackgroundSetupInspection(fixture.options), { code: 'dispatch_uncertain' });
    assert.equal(fixture.pageCalls.filter((operation) => operation === 'dispatch').length,
      lostOperation === 'dispatch_started' ? 0 : 1);
    assert.equal(fixture.messages.filter((message) => message.operation === 'request_permit').length, 1);
    assert.equal(fixture.pageCalls.at(-1), 'abort');
    assert.doesNotMatch(JSON.stringify(fixture.messages), /private-transport-sentinel/);
  }
});

test('background setup does not accept a page identity or forward credential-shaped chunks', async () => {
  const invalid = backgroundFixture();
  delete invalid.options.collector.collectorInstanceId;
  invalid.options.collector.documentId = 'synthetic-document';
  await assert.rejects(runBackgroundSetupInspection(invalid.options), { code: 'invalid_probe_message' });
  assert.deepEqual(invalid.messages, []);
  const poisoned = backgroundFixture({ poison: true });
  await assert.rejects(runBackgroundSetupInspection(poisoned.options), { code: 'invalid_probe_message' });
  assert.equal(poisoned.messages.filter((message) => message.operation === 'result_chunk').length, 0);
});

test('setup inspection does not commit after final page release loses context', async () => {
  const fixture = syntheticProbe({ setup: true });
  const pageCall = fixture.options.page.call;
  fixture.options.page.call = async (command) => command.operation === 'release'
    ? { ok: false, error: { failure_class: 'identity_mismatch' } }
    : pageCall(command);
  await assert.rejects(runSetupInspection(fixture.options), { code: 'invalid_probe_message' });
  assert.equal(fixture.messages.filter((message) => message.operation === 'commit_result').length, 0);
  assert.deepEqual(fixture.pageCalls, ['dispatch', 'pull', 'abort']);
});

test('setup inspection requires a null configured context and rejects an unexpected body permit', async () => {
  const fixture = syntheticProbe({ setup: true });
  fixture.options.binding.context_id = 'preconfigured-context';
  await assert.rejects(runSetupInspection(fixture.options), { code: 'invalid_probe_message' });

  const bodyPermit = syntheticProbe({ setup: true });
  const original = bodyPermit.options.request;
  bodyPermit.options.request = async (message) => {
    const reply = await original(message);
    if (message.operation === 'request_permit') {
      reply.result.request_kind = 'body';
      reply.result.arguments = { conversation_ids: ['synthetic-conversation'] };
    }
    return reply;
  };
  await assert.rejects(runSetupInspection(bodyPermit.options), { code: 'invalid_probe_message' });
  assert.deepEqual(bodyPermit.pageCalls, ['abort']);
});

test('setup inspection rejects a returned principal mismatch before native chunks', async () => {
  const fixture = syntheticProbe({ setup: true });
  const original = fixture.options.page.call;
  fixture.options.page.call = async (command) => {
    const result = await original(command);
    if (command.operation !== 'pull') return result;
    const bytes = Buffer.from(JSON.stringify({ principal_id: 'wrong-principal', context_id: 'setup-context' }));
    return { ...result, data: bytes.toString('base64'), decoded_bytes: bytes.length };
  };
  await assert.rejects(runSetupInspection(fixture.options), { code: 'invalid_probe_message' });
  assert.equal(fixture.messages.some((message) => message.operation === 'result_chunk'), false);
});

test('session-only qualification stops on lost ACK and persists failures without a second dispatch', async () => {
  for (const options of [{ loseCommit: true }, { failure: { failure_class: 'rate_limited', http_status: 429, retry_after: '3601' } }]) {
    const fixture = syntheticProbe(options);
    await assert.rejects(runSessionCheck(fixture.options), { code: options.loseCommit ? 'dispatch_uncertain' : 'probe_failed' });
    assert.equal(fixture.pageCalls.filter((op) => op === 'dispatch').length, 1);
    assert.equal(fixture.messages.filter((message) => message.operation === 'request_permit').length, 1);
    assert.equal(fixture.pageCalls.at(-1), 'abort');
    assert.equal(fixture.stored.length, options.loseCommit ? 0 : 1);
  }
});

test('session-only qualification refuses an unexpected body permit before page dispatch', async () => {
  const fixture = syntheticProbe();
  const original = fixture.options.request;
  fixture.options.request = async (message) => {
    const reply = await original(message);
    if (message.operation === 'request_permit') {
      reply.result.request_kind = 'body';
      reply.result.arguments = { conversation_ids: ['synthetic-conversation'] };
    }
    return reply;
  };
  await assert.rejects(runSessionCheck(fixture.options), { code: 'invalid_probe_message' });
  assert.deepEqual(fixture.pageCalls, ['abort']);
  assert.equal(fixture.messages.some((message) => message.operation === 'dispatch_started'), false);
});

test('both qualification clients reject oversized or multi-chunk session declarations before pulling', async () => {
  for (const run of [runProbe, runSessionCheck]) {
    for (const change of [{ raw_bytes: 16385 }, { chunk_count: 2 }]) {
      const fixture = syntheticProbe();
      const original = fixture.options.page.call;
      fixture.options.page.call = async (command) => {
        const result = await original(command);
        return command.operation === 'dispatch' ? { ...result, ...change } : result;
      };
      await assert.rejects(run(fixture.options), { code: 'invalid_probe_message' });
      assert.equal(fixture.pageCalls.includes('pull'), false);
      assert.equal(fixture.messages.some((message) => message.operation === 'result_chunk'), false);
    }
  }
});

test('session chunks with extra fields or mismatched identity never reach native storage', async () => {
  for (const run of [runProbe, runSessionCheck]) {
    for (const value of [{ ...binding, token: 'SYNTHETIC_PAGE_ONLY_TOKEN' },
      { ...binding, principal_id: 'wrong-principal' }, { ...binding, context_id: 'wrong-context' }, null]) {
      const fixture = syntheticProbe();
      const original = fixture.options.page.call;
      fixture.options.page.call = async (command) => {
        const result = await original(command);
        if (command.operation !== 'pull') return result;
        const bytes = Buffer.from(JSON.stringify(value));
        return { ...result, data: bytes.toString('base64'), decoded_bytes: bytes.length };
      };
      await assert.rejects(run(fixture.options), { code: 'invalid_probe_message' });
      assert.equal(fixture.messages.some((message) => message.operation === 'result_chunk'), false);
      assert.equal(JSON.stringify(fixture.messages).includes('SYNTHETIC_PAGE_ONLY_TOKEN'), false);
    }
  }
});

test('session chunks cannot hide discarded values in duplicate JSON keys or invalid UTF-8', async () => {
  for (const data of [
    Buffer.from(`{"principal_id":"SYNTHETIC_PAGE_ONLY_TOKEN",${JSON.stringify(binding).slice(1)}`),
    Buffer.concat([Buffer.from([0xff]), Buffer.from(JSON.stringify(binding))]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(binding))]),
  ]) {
    const fixture = syntheticProbe();
    const original = fixture.options.page.call;
    fixture.options.page.call = async (command) => {
      const result = await original(command);
      return command.operation === 'pull'
        ? { ...result, data: data.toString('base64'), decoded_bytes: data.length } : result;
    };
    await assert.rejects(runSessionCheck(fixture.options), { code: 'invalid_probe_message' });
    assert.equal(fixture.messages.some((message) => message.operation === 'result_chunk'), false);
  }
});

function event() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
    emit: (message) => { for (const fn of listeners) fn(message); } };
}
function fakePort() {
  const sent = [];
  const port = { onMessage: event(), onDisconnect: event(), postMessage(message) { sent.push(message); },
    disconnect() { this.onDisconnect.emit(); } };
  const chromeApi = { runtime: { connectNative(name) {
    assert.equal(name, 'local.miyo_chatgpt_catchup'); return port;
  } } };
  return { port, sent, client: createNativeClient(chromeApi, { timeoutMs: 100 }) };
}

test('AC06: native client bounds outstanding work and never retries after disconnect', async () => {
  const { client, port, sent } = fakePort();
  const first = client.request({ request_id: randomUUID() });
  await assert.rejects(client.request({ request_id: randomUUID() }), { code: 'busy' });
  port.onDisconnect.emit();
  await assert.rejects(first, { code: 'dispatch_uncertain' });
  await assert.rejects(client.request({ request_id: randomUUID() }), { code: 'dispatch_uncertain' });
  assert.equal(sent.length, 1);
  client.close();
});

test('AC06: mismatched native reply poisons connection rather than accepting another request ACK', async () => {
  const { client, port } = fakePort();
  const first = client.request({ request_id: randomUUID() });
  port.onMessage.emit({ protocol_version: 1, request_id: randomUUID(), ok: true, result: {} });
  await assert.rejects(first, { code: 'dispatch_uncertain' });
  client.close();
});

test('AC13: native preflight rejects oversized and non-inert JSON before serialization or posting', () => {
  const { client, sent } = fakePort();
  let invoked = false;
  for (const value of [
    { request_id: randomUUID(), data: 'x'.repeat(262144) },
    { request_id: randomUUID(), a: '🌲'.repeat(33000), b: '🌲'.repeat(33000) },
    { request_id: randomUUID(), get data() { invoked = true; return 'sentinel'; } },
    { request_id: randomUUID(), toJSON() { invoked = true; return {}; } },
  ]) assert.throws(() => client.request(value), { code: 'invalid_probe_message' });
  assert.equal(invoked, false);
  assert.equal(sent.length, 0);
  client.close();
});
