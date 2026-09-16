import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';
import { pageCollector } from '../extension/page-collector.mjs';
import { createNativeClient, runProbe } from '../extension/probe-client.mjs';
import { assertReply, assertRequest } from '../src/contracts.mjs';
import { encodeNativeMessage, NativeFrameDecoder } from '../src/framing.mjs';
import { runNativeHost } from '../src/native-host.mjs';
import { createProbeReceiver } from '../src/probe-receiver.mjs';
import { connectProbeSocket, createProbeSocketServer } from '../src/probe-socket.mjs';
import { FakeClock, temporaryRoot } from './helpers/harness.mjs';

function event() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
    emit: (value) => { for (const fn of listeners) fn(value); } };
}

test('T02 vertical synthetic proof: fixed page -> native frames -> Unix socket -> durable private bytes', async (t) => {
  const root = temporaryRoot(t);
  const clock = new FakeClock();
  const binding = { binding_id: 'synthetic-binding', principal_id: 'synthetic-principal',
    context_id: 'synthetic-personal', account_id: 'synthetic-account' };
  const conversationId = 'synthetic-conversation';
  const body = Buffer.from(JSON.stringify({ conversation: { id: conversationId }, text: '雪🌿'.repeat(60000) }));
  const tokenSentinel = 'SYNTHETIC_PAGE_ONLY_TOKEN';
  const cookieSentinel = 'SYNTHETIC_PAGE_ONLY_COOKIE';
  const calls = [];
  const boundaryReplies = [];
  class SyntheticDate extends Date { static now() { return clock.wall; } }
  const realm = vm.createContext({
    location: { origin: 'https://miyo-catchup.invalid' },
    __MIYO_CATCHUP_SYNTHETIC_TEST__: true,
    performance: { now: () => clock.monotonic }, Date: SyntheticDate,
    TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, crypto: webcrypto,
    fetch: async (path, options) => {
      calls.push({ path, method: options.method });
      assert.equal(options.credentials, 'same-origin');
      let bytes;
      if (path === '/api/auth/session') {
        assert.equal(options.method, 'GET');
        bytes = Buffer.from(JSON.stringify({ user: { id: binding.principal_id },
          context: { id: binding.context_id }, token: tokenSentinel, cookie: cookieSentinel }));
      } else {
        assert.equal(path, '/backend-api/conversations/batch');
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), { conversation_ids: [conversationId] });
        assert.equal(options.headers.authorization, `Bearer ${tokenSentinel}`);
        bytes = body;
      }
      let offset = 0;
      return { status: 200, body: { getReader: () => ({
        async read() {
          if (offset === bytes.length) return { done: true };
          // Force stream splits within multibyte text independently of pulls.
          const chunk = bytes.subarray(offset, Math.min(offset + 8191, bytes.length));
          offset += chunk.length;
          return { done: false, value: chunk };
        },
        async cancel() {},
      }) } };
    },
  });
  vm.runInContext(`globalThis.collector = (${pageCollector.toString()})`, realm);
  const callPage = async (command) => {
    realm.commandJson = JSON.stringify(command);
    const raw = await vm.runInContext('collector(JSON.parse(commandJson))', realm);
    const result = JSON.parse(JSON.stringify(raw));
    boundaryReplies.push(JSON.stringify(result));
    return result;
  };
  assert.equal((await callPage({ operation: 'initialize',
    binding: { principal_id: binding.principal_id, context_id: binding.context_id },
    conversation_id: conversationId, qualification: { adapter_id: 'synthetic-v1' } })).ok, true);
  const receiver = createProbeReceiver({ root, trustedBoundary: root, binding,
    conversationId, clock, ownership: () => true, // synthetic caller-held lock attestation
    validateBody: (parsed, expected) => parsed.conversation?.id === expected && typeof parsed.text === 'string' });
  t.after(() => receiver.close());
  const socketRoot = mkdtempSync(join(tmpdir(), 'miyo-t02-vertical-'));
  let socketServer;
  let closeHost = async () => {};
  t.after(async () => {
    try { await closeHost(); } finally {
      try { await socketServer?.close(); } finally { rmSync(socketRoot, { recursive: true, force: true }); }
    }
  });
  const socketPath = join(socketRoot, 'probe.sock');
  socketServer = await createProbeSocketServer({ socketPath, privateRoot: socketRoot,
    trustedBoundary: socketRoot, ownership: () => true, receiver });
  const input = new PassThrough();
  const output = new PassThrough();
  const wire = [];
  let expectedOperation;
  let disconnected = false;
  const port = { onMessage: event(), onDisconnect: event(),
    postMessage(message) {
      expectedOperation = message.operation;
      wire.push(JSON.stringify(message));
      const frame = encodeNativeMessage(message, assertRequest);
      input.write(frame.subarray(0, 3));
      input.write(frame.subarray(3));
    },
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      input.end();
      this.onDisconnect.emit();
    },
  };
  const client = createNativeClient({ runtime: { connectNative(name) {
    assert.equal(name, 'local.miyo_chatgpt_catchup'); return port;
  } } });
  const extensionId = 'a'.repeat(32);
  const host = runNativeHost({ input, output, extensionId, origin: `chrome-extension://${extensionId}/`,
    connectWorker: () => connectProbeSocket({ socketPath, trustedBoundary: socketRoot }) });
  const decoder = new NativeFrameDecoder((reply) => assertReply(reply, expectedOperation));
  const replies = (async () => {
    for await (const chunk of output) await decoder.consume(chunk, (reply) => port.onMessage.emit(reply));
    decoder.finish();
  })();
  closeHost = async () => { client.close(); await host; output.end(); await replies; };
  const result = await runProbe({ request: (message) => client.request(message),
    page: { documentId: 'synthetic-document', call: callPage }, browserInstanceId: randomUUID(),
    binding: { principal_id: binding.principal_id, context_id: binding.context_id }, conversationId,
    wait: async (ms) => clock.advance(ms), persistFailure: async () => assert.fail('unexpected failure receipt') });
  assert.equal(result.state, 'probe_complete');
  assert.equal(receiver.snapshot().probe_complete, true);
  assert.equal(receiver.snapshot().catalog_complete, false);
  assert.equal(receiver.snapshot().verified, false);
  const receipt = result.receipts[1];
  assert.equal(receipt.sha256, createHash('sha256').update(body).digest('hex'));
  assert.deepEqual(readFileSync(join(root, 'artifacts', `${receipt.artifact_id}.json`)), body);
  assert.deepEqual(calls, [{ path: '/api/auth/session', method: 'GET' },
    { path: '/backend-api/conversations/batch', method: 'POST' }]);
  for (const serialized of [...wire, ...boundaryReplies]) {
    assert.ok(Buffer.byteLength(serialized) <= 262144);
    assert.ok(!serialized.includes(tokenSentinel));
    assert.ok(!serialized.includes(cookieSentinel));
  }
});
