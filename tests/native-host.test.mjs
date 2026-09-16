import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import {
  NATIVE_HOST_NAME,
  NativeHostError,
  nativeHostManifest,
  runNativeHost,
  validateCallerOrigin,
} from '../src/native-host.mjs';
import { assertReply, assertRequest } from '../src/contracts.mjs';
import { encodeNativeMessage, NativeFrameDecoder } from '../src/framing.mjs';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const origin = `chrome-extension://${extensionId}/`;
const id1 = '11111111-1111-4111-8111-111111111111';
const id2 = '22222222-2222-4222-8222-222222222222';

function hello(requestId = id1) {
  return {
    protocol_version: 1,
    request_id: requestId,
    operation: 'hello',
    payload: {
      extension_version: '1.0.0',
      browser_instance_id: id1,
      capabilities: ['session_check', 'chunking'],
    },
  };
}

function reply(requestId = id1) {
  return {
    protocol_version: 1,
    request_id: requestId,
    ok: true,
    result: {
      worker_instance_id: id2,
      protocol_version: 1,
      config_version: 1,
    },
  };
}

function connectorFor(handler) {
  const state = { calls: [], closed: 0 };
  return {
    state,
    connector: {
      request: async (request) => {
        state.calls.push(structuredClone(request));
        return handler(request);
      },
      close: async () => { state.closed += 1; },
    },
  };
}

async function readFrames(output, operations = ['hello']) {
  const decoder = new NativeFrameDecoder((value) => {
    const operation = operations.shift() ?? 'hello';
    assertReply(value, operation);
  });
  const messages = [];
  for await (const chunk of output) {
    await decoder.consume(chunk, (message) => messages.push(message));
  }
  decoder.finish();
  return messages;
}

test('caller origin is exact and manifest has one non-wildcard origin', () => {
  assert.equal(validateCallerOrigin(origin, extensionId), true);
  assert.equal(validateCallerOrigin(`chrome-extension://${extensionId}`, extensionId), false);
  assert.equal(validateCallerOrigin(`chrome-extension://${extensionId}/extra`, extensionId), false);
  assert.equal(validateCallerOrigin(`Chrome-extension://${extensionId}/`, extensionId), false);
  assert.equal(validateCallerOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnq/', extensionId), false);

  const manifest = nativeHostManifest({ extensionId, executablePath: '/tmp/miyo-catchup-host' });
  assert.equal(manifest.name, NATIVE_HOST_NAME);
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path, '/tmp/miyo-catchup-host');
  assert.deepEqual(manifest.allowed_origins, [origin]);
  assert.equal(Object.hasOwn(manifest, 'allowed_origins') && manifest.allowed_origins.includes('*'), false);
  assert.throws(() => nativeHostManifest({ extensionId, executablePath: 'relative/host' }), /invalid_executable_path/);
  assert.throws(() => nativeHostManifest({ extensionId, executablePath: '/tmp/../host' }), /invalid_executable_path/);
});

test('invalid caller fails before connecting to the worker', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let connected = 0;
  await assert.rejects(
    runNativeHost({ input, output, origin: 'chrome-extension://bad/', extensionId, connectWorker: async () => {
      connected += 1;
      return connectorFor(() => reply()).connector;
    } }),
    (error) => error instanceof NativeHostError && error.code === 'unauthorized_origin',
  );
  assert.equal(connected, 0);
  input.destroy();
  output.destroy();
});

test('split and coalesced native frames are pumped serially with exact replies', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const { connector, state } = connectorFor((request) => reply(request.request_id));
  const run = runNativeHost({ input, output, origin, extensionId, connectWorker: async () => connector });
  const frames = [hello(id1), hello(id2)].map((request) => encodeNativeMessage(request, assertRequest));
  input.write(frames[0].subarray(0, 3));
  input.write(Buffer.concat([frames[0].subarray(3), frames[1].subarray(0, 7)]));
  input.end(frames[1].subarray(7));
  const result = await run;
  output.end();
  const messages = await readFrames(output, ['hello', 'hello']);
  assert.equal(result.processed, 2);
  assert.deepEqual(messages.map((message) => message.request_id), [id1, id2]);
  assert.deepEqual(state.calls.map((request) => request.request_id), [id1, id2]);
  assert.equal(state.closed, 1);
});

test('wrong, reordered or malformed worker replies fail closed and close the connector', async () => {
  for (const [name, handler, expectedCode] of [
    ['wrong request id', () => reply(id2), 'worker_reply_mismatch'],
    ['wrong reply shape', () => ({ protocol_version: 1, request_id: id1, ok: true, result: {} }), 'invalid_worker_reply'],
    ['unsolicited raw value', () => ({ hello: 'diagnostic' }), 'invalid_worker_reply'],
  ]) {
    await test(name, async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      const { connector, state } = connectorFor(handler);
      const run = runNativeHost({ input, output, origin, extensionId, connectWorker: async () => connector });
      input.end(encodeNativeMessage(hello(), assertRequest));
      await assert.rejects(run, (error) => error instanceof NativeHostError && error.code === expectedCode);
      assert.equal(state.closed, 1);
      input.destroy();
      output.destroy();
    });
  }
});

test('output backpressure is awaited and all stdout bytes are framed', async () => {
  const input = new PassThrough();
  const chunks = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      setTimeout(callback, 5);
    },
  });
  const { connector, state } = connectorFor((request) => reply(request.request_id));
  const run = runNativeHost({ input, output, origin, extensionId, connectWorker: async () => connector });
  input.end(encodeNativeMessage(hello(), assertRequest));
  const result = await run;
  assert.equal(result.processed, 1);
  assert.equal(state.closed, 1);
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.readUInt32LE(0), bytes.length - 4);
  assert.equal(JSON.parse(bytes.subarray(4).toString('utf8')).request_id, id1);
  assert.equal(bytes.subarray(4).toString('utf8').includes('diagnostic'), false);
  output.destroy();
});

test('input truncation and output loss do not retry dispatch', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const { connector, state } = connectorFor((request) => reply(request.request_id));
  const run = runNativeHost({ input, output, origin, extensionId, connectWorker: async () => connector });
  const frame = encodeNativeMessage(hello(), assertRequest);
  input.write(frame.subarray(0, frame.length - 1));
  input.end();
  await assert.rejects(run, (error) => error instanceof NativeHostError && error.code === 'truncated_input');
  assert.equal(state.calls.length, 0);
  assert.equal(state.closed, 1);
  input.destroy();
  output.destroy();

  const input2 = new PassThrough();
  const output2 = new PassThrough();
  const second = connectorFor((request) => reply(request.request_id));
  const run2 = runNativeHost({ input: input2, output: output2, origin, extensionId, connectWorker: async () => second.connector });
  output2.destroy();
  input2.end(encodeNativeMessage(hello(), assertRequest));
  await assert.rejects(run2, (error) => error instanceof NativeHostError && error.code === 'output_closed');
  assert.equal(second.state.calls.length, 1);
  assert.equal(second.state.closed, 1);
  input2.destroy();
});

test('input close and output close/error cancel pending work and close the connector', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const first = { closed: 0, calls: 0 };
  const connector = {
    request: async () => {
      first.calls += 1;
      return new Promise(() => {});
    },
    close: async () => { first.closed += 1; },
  };
  const run = runNativeHost({ input, output, origin, extensionId, connectWorker: async () => connector });
  input.write(encodeNativeMessage(hello(), assertRequest));
  await new Promise((resolve) => setImmediate(resolve));
  input.destroy(new Error('synthetic input failure'));
  await assert.rejects(run, (error) => error instanceof NativeHostError && error.code === 'input_failed');
  assert.equal(first.calls, 1);
  assert.equal(first.closed, 1);
  output.destroy();

  const input2 = new PassThrough();
  const output2 = new PassThrough();
  const second = connectorFor((request) => reply(request.request_id));
  const run2 = runNativeHost({ input: input2, output: output2, origin, extensionId, connectWorker: async () => second.connector });
  output2.destroy();
  await assert.rejects(run2, (error) => error instanceof NativeHostError && error.code === 'output_closed');
  assert.equal(second.state.closed, 1);
  input2.destroy();

  const input3 = new PassThrough();
  const output3 = new Writable({
    write(chunk, encoding, callback) {
      callback();
      queueMicrotask(() => this.destroy(new Error('synthetic output failure')));
    },
  });
  const third = connectorFor((request) => reply(request.request_id));
  const run3 = runNativeHost({ input: input3, output: output3, origin, extensionId, connectWorker: async () => third.connector });
  input3.write(encodeNativeMessage(hello(), assertRequest));
  await assert.rejects(run3, (error) => error instanceof NativeHostError && error.code === 'output_failed');
  assert.equal(third.state.closed, 1);
  input3.destroy();
});

test('input EOF during a pending worker request cancels without waiting forever', { timeout: 1_000 }, async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const state = { calls: 0, closed: 0 };
  const connector = {
    request: async () => {
      state.calls += 1;
      return new Promise(() => {});
    },
    close: async () => { state.closed += 1; },
  };
  const run = runNativeHost({ input, output, origin, extensionId, connectWorker: async () => connector });
  input.write(encodeNativeMessage(hello(), assertRequest));
  await new Promise((resolve) => setImmediate(resolve));
  input.end();
  await assert.rejects(run, (error) => error instanceof NativeHostError && error.code === 'input_closed');
  assert.equal(state.calls, 1);
  assert.equal(state.closed, 1);
  output.destroy();
});

test('long serial stream does not accumulate per-frame cancellation or drain listeners', async () => {
  const input = new PassThrough();
  const output = new Writable({
    highWaterMark: 2 * 1024 * 1024,
    write(chunk, encoding, callback) { callback(); },
  });
  const count = 1_500;
  const { connector, state } = connectorFor((request) => reply(request.request_id));
  const run = runNativeHost({ input, output, origin, extensionId, connectWorker: async () => connector });
  const frame = encodeNativeMessage(hello(), assertRequest);
  input.end(Buffer.concat(Array.from({ length: count }, () => frame)));
  const result = await run;
  assert.equal(result.processed, count);
  assert.equal(state.calls.length, count);
  assert.equal(state.closed, 1);
  // One lifetime guard is retained for late async output errors; no per-frame
  // drain/error listeners remain after each write settles.
  assert.equal(output.listenerCount('error'), 1);
  assert.equal(output.listenerCount('close'), 1);
  output.destroy();
});
