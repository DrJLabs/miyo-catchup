import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';
import { pageCollector } from '../extension/page-collector.mjs';
import { createBackgroundSetupCollector } from '../extension/background-setup-collector.mjs';
import {
  createNativeClient, runBackgroundSetupInspection, runProbe, runSessionCheck, runSetupInspection,
} from '../extension/probe-client.mjs';
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

async function runVerticalProof(t, scope) {
  const setup = scope === 'setup-inspection';
  const root = temporaryRoot(t);
  const clock = new FakeClock();
  const binding = { binding_id: 'synthetic-binding', principal_id: 'synthetic-principal',
    context_id: setup ? null : 'synthetic-personal',
    account_id: setup ? 'synthetic-principal' : 'synthetic-account' };
  const observedContext = 'synthetic-personal';
  const conversationId = 'synthetic-conversation';
  const body = Buffer.from(JSON.stringify({ conversation: { id: conversationId }, text: '雪🌿'.repeat(60000) }));
  const tokenSentinel = 'SYNTHETIC_PAGE_ONLY_TOKEN';
  const cookieSentinel = 'SYNTHETIC_PAGE_ONLY_COOKIE';
  const setupToken = ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: observedContext },
    sentinel: tokenSentinel,
  })).toString('base64url'), 'synthetic-signature'].join('.');
  const calls = [];
  const boundaryReplies = [];
  class SyntheticDate extends Date { static now() { return clock.wall; } }
  const realm = vm.createContext({
    location: { origin: setup ? 'https://chatgpt.com' : 'https://miyo-catchup.invalid' },
    document: { cookie: `_account=personal; synthetic_secret=${cookieSentinel}` },
    atob, btoa,
    __MIYO_CATCHUP_SYNTHETIC_TEST__: true,
    performance: { now: () => clock.monotonic }, Date: SyntheticDate,
    TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, crypto: webcrypto,
    fetch: async (path, options) => {
      calls.push({ path, method: options.method });
      assert.equal(options.credentials, 'same-origin');
      let bytes;
      if (path === '/api/auth/session') {
        assert.equal(options.method, 'GET');
        bytes = Buffer.from(JSON.stringify(setup
          ? { user: { id: binding.principal_id },
            account: { id: observedContext, structure: 'personal' }, accessToken: setupToken }
          : { user: { id: binding.principal_id },
            context: { id: binding.context_id }, token: tokenSentinel, cookie: cookieSentinel }));
      } else {
        assert.equal(setup, false, 'setup inspection must never request a body');
        assert.equal(path, '/backend-api/conversations/batch');
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), { conversation_ids: [conversationId] });
        assert.equal(options.headers.authorization, `Bearer ${tokenSentinel}`);
        bytes = body;
      }
      let offset = 0;
      return { status: 200, headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null }, body: { getReader: () => ({
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
    conversation_id: conversationId, qualification: {
      adapter_id: setup ? 'chatgpt-setup-2026-09-16' : 'synthetic-v1',
    } })).ok, true);
  const receiver = createProbeReceiver({ root, trustedBoundary: root, binding,
    conversationId, clock, scope, ownership: () => true, // synthetic caller-held lock attestation
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
  const run = setup ? runSetupInspection : scope === 'session-only' ? runSessionCheck : runProbe;
  const result = await run({ request: (message) => client.request(message),
    page: { documentId: 'synthetic-document', call: callPage }, browserInstanceId: randomUUID(),
    binding: { principal_id: binding.principal_id, context_id: binding.context_id }, conversationId,
    wait: async (ms) => clock.advance(ms), persistFailure: async () => assert.fail('unexpected failure receipt') });
  assert.equal(result.state, setup ? 'setup_inspection_complete' : scope === 'session-only' ? 'session_check_complete' : 'probe_complete');
  assert.equal(receiver.snapshot().probe_complete, scope === 'conversation');
  if (setup) assert.equal(receiver.snapshot().setup_complete, true);
  assert.equal(receiver.snapshot().catalog_complete, false);
  assert.equal(receiver.snapshot().verified, false);
  if (scope === 'conversation') {
    const receipt = result.receipts[1];
    assert.equal(receipt.sha256, createHash('sha256').update(body).digest('hex'));
    assert.deepEqual(readFileSync(join(root, 'artifacts', `${receipt.artifact_id}.json`)), body);
    assert.deepEqual(calls, [{ path: '/api/auth/session', method: 'GET' },
      { path: '/backend-api/conversations/batch', method: 'POST' }]);
  } else {
    assert.equal(result.receipts.length, 1);
    const sanitized = Buffer.from(JSON.stringify({ principal_id: binding.principal_id,
      context_id: setup ? observedContext : binding.context_id }));
    assert.equal(result.receipts[0].sha256, createHash('sha256').update(sanitized).digest('hex'));
    assert.equal(result.receipts[0].raw_bytes, sanitized.length);
    assert.deepEqual(readFileSync(join(root, 'artifacts', `${result.receipts[0].artifact_id}.json`)), sanitized);
    assert.deepEqual(calls, [{ path: '/api/auth/session', method: 'GET' }]);
    assert.equal(wire.filter((message) => JSON.parse(message).operation === 'request_permit').length, 1);
    assert.equal((await callPage({ operation: 'release' })).ok, false);
  }
  for (const serialized of [...wire, ...boundaryReplies]) {
    assert.ok(Buffer.byteLength(serialized) <= 262144);
    assert.ok(!serialized.includes(tokenSentinel));
    assert.ok(!serialized.includes(cookieSentinel));
    assert.ok(!serialized.includes(setupToken));
  }
}

for (const scope of ['conversation', 'session-only', 'setup-inspection']) {
  test(`T02 ${scope} vertical synthetic proof: fixed page -> native frames -> Unix socket -> durable private bytes`,
    (t) => runVerticalProof(t, scope));
}

async function runBackgroundVerticalProof(t) {
  const root = temporaryRoot(t);
  const clock = new FakeClock();
  const binding = { principal_id: 'synthetic-background-principal', context_id: null };
  const observedContext = 'synthetic-personal';
  const collectorInstanceId = '44444444-4444-4444-8444-444444444444';
  const tokenSentinel = 'SYNTHETIC_BACKGROUND_TOKEN';
  const emailSentinel = 'synthetic-background@example.invalid';
  const cookieSentinel = 'SYNTHETIC_BACKGROUND_COOKIE';
  let dispatchAcked = false;
  const jwtPayload = Buffer.from(JSON.stringify({
    exp: Math.floor(clock.wall / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: observedContext },
    tokenSentinel,
  })).toString('base64url');
  const accessToken = `header.${jwtPayload}.signature`;
  const calls = [];
  const wire = [];
  const responseBytes = Buffer.from(JSON.stringify({
    user: { id: binding.principal_id, email: emailSentinel },
    account: { id: observedContext, structure: 'personal' },
    accessToken,
    cookie: cookieSentinel,
  }));
  const fetchImpl = async (url, options) => {
    assert.equal(dispatchAcked, true,
      'authenticated fetch must follow the durable dispatch ACK');
    calls.push({ url, method: options.method });
    assert.equal(url, 'https://chatgpt.com/api/auth/session');
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'include');
    let offset = 0;
    return {
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
      body: { getReader: () => ({
        async read() {
          if (offset === responseBytes.length) return { done: true };
          const chunk = responseBytes.subarray(offset, Math.min(offset + 17, responseBytes.length));
          offset += chunk.length;
          return { done: false, value: chunk };
        },
        async cancel() {},
      }) },
    };
  };
  const collector = createBackgroundSetupCollector({ binding, fetchImpl,
    uuid: () => collectorInstanceId, wallNow: () => clock.wall });
  const receiver = createProbeReceiver({ root, trustedBoundary: root,
    binding: { binding_id: 'synthetic-background-binding', ...binding, account_id: binding.principal_id },
    conversationId: 'synthetic-background-conversation', clock,
    scope: 'background-setup-inspection', ownership: () => true });
  t.after(() => receiver.close());
  const socketRoot = mkdtempSync(join(tmpdir(), 'miyo-t02-background-vertical-'));
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
  const extensionId = 'b'.repeat(32);
  const host = runNativeHost({ input, output, extensionId, origin: `chrome-extension://${extensionId}/`,
    connectWorker: () => connectProbeSocket({ socketPath, trustedBoundary: socketRoot }) });
  const decoder = new NativeFrameDecoder((reply) => {
    assertReply(reply, expectedOperation);
    if (expectedOperation === 'dispatch_started' && reply.ok === true) dispatchAcked = true;
  });
  const replies = (async () => {
    for await (const chunk of output) await decoder.consume(chunk, (reply) => port.onMessage.emit(reply));
    decoder.finish();
  })();
  closeHost = async () => { client.close(); await host; output.end(); await replies; };
  const result = await runBackgroundSetupInspection({
    request: (message) => client.request(message), collector,
    browserInstanceId: randomUUID(),
    binding,
    wait: async (ms) => clock.advance(ms),
    persistFailure: async () => assert.fail('unexpected failure receipt'),
  });
  assert.equal(result.state, 'background_setup_inspection_complete');
  assert.equal(result.receipts.length, 1);
  assert.deepEqual(calls, [{ url: 'https://chatgpt.com/api/auth/session', method: 'GET' }]);
  const receipt = result.receipts[0];
  const sanitized = Buffer.from(JSON.stringify({ principal_id: binding.principal_id, context_id: observedContext }));
  assert.equal(receipt.sha256, createHash('sha256').update(sanitized).digest('hex'));
  assert.equal(receipt.raw_bytes, sanitized.length);
  assert.deepEqual(readFileSync(join(root, 'artifacts', `${receipt.artifact_id}.json`)), sanitized);
  const snapshot = receiver.snapshot();
  assert.equal(snapshot.background_setup_complete, true);
  assert.equal(snapshot.setup_complete, false);
  assert.equal(snapshot.probe_complete, false);
  assert.equal(snapshot.attested, false);
  const stateBytes = readFileSync(join(root, 'probe-state.db'));
  for (const sentinel of [tokenSentinel, emailSentinel, cookieSentinel]) {
    assert.equal(stateBytes.includes(Buffer.from(sentinel)), false, `state contains ${sentinel}`);
  }
  for (const serialized of wire) {
    assert.ok(Buffer.byteLength(serialized) <= 262144);
    assert.ok(!serialized.includes(tokenSentinel));
    assert.ok(!serialized.includes(emailSentinel));
    assert.ok(!serialized.includes(cookieSentinel));
    assert.ok(!serialized.includes('document_id'));
    assert.ok(serialized.includes(collectorInstanceId) || !serialized.includes('dispatch_started'));
  }
  const artifactBytes = readFileSync(join(root, 'artifacts', `${receipt.artifact_id}.json`));
  for (const sentinel of [tokenSentinel, emailSentinel, cookieSentinel]) {
    assert.equal(artifactBytes.includes(Buffer.from(sentinel)), false, `artifact contains ${sentinel}`);
  }
  await collector.call({ operation: 'abort' });
  await closeHost();
  receiver.close();
  const reopened = createProbeReceiver({ root, trustedBoundary: root,
    binding: { binding_id: 'synthetic-background-binding', ...binding, account_id: binding.principal_id },
    conversationId: 'synthetic-background-conversation', clock,
    scope: 'background-setup-inspection', ownership: () => true });
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().background_setup_complete, true);
  assert.equal(reopened.snapshot().attested, false);
  assert.equal(reopened.snapshot().probe_complete, false);
}

test('T02 background setup synthetic vertical proof: collector -> native frames -> Unix socket -> durable private bytes',
  (t) => runBackgroundVerticalProof(t));
