import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createNativeClient, runProbe } from '../extension/probe-client.mjs';
import { assertReply, assertRequest, MAX_RAW_CHUNK_BYTES } from '../src/contracts.mjs';

const binding = { principal_id: 'synthetic-user', context_id: 'synthetic-personal' };
const browserInstanceId = randomUUID();
const documentId = 'synthetic-document';

function syntheticProbe({ loseCommit = false, failure, poison = false } = {}) {
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
        bytes = Buffer.from(kind === 'session_check' ? JSON.stringify(binding)
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
  return { messages, pageCalls, stored, waits, options: { request, page, binding, browserInstanceId,
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
