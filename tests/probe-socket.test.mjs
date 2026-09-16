import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';

import {
  createProbeSocketServer,
  connectProbeSocket,
  ProbeSocketError,
} from '../src/probe-socket.mjs';

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

function helloReply(request) {
  return {
    protocol_version: 1,
    request_id: request.request_id,
    ok: true,
    result: {
      worker_instance_id: id2,
      protocol_version: 1,
      config_version: 1,
    },
  };
}

function rootFixture() {
  const root = mkdtempSync(join(tmpdir(), 'miyo-probe-socket-'));
  chmodSync(root, 0o700);
  return { root, socketPath: join(root, 'worker.sock') };
}

async function closeQuietly(resource) {
  if (!resource) return;
  try { await resource.close(); } catch { /* test cleanup */ }
}

test('private socket connector round-trips exact request IDs and replies', async (t) => {
  const { root, socketPath } = rootFixture();
  let server;
  let client;
  t.after(async () => {
    await closeQuietly(client);
    await closeQuietly(server);
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  server = await createProbeSocketServer({
    socketPath,
    privateRoot: root,
    trustedBoundary: root,
    ownership: () => true,
    receiver: { request: async (request) => helloReply(request) },
  });
  client = await connectProbeSocket({
    socketPath,
    privateRoot: root,
    trustedBoundary: root,
  });
  const first = await client.request(hello(id1));
  const second = await client.request(hello(id2));
  assert.equal(first.request_id, id1);
  assert.equal(second.request_id, id2);
  assert.equal(lstatSync(socketPath).mode & 0o777, 0o600);
});

test('malformed and oversized frames fail closed without a diagnostic response', async (t) => {
  const { root, socketPath } = rootFixture();
  let server;
  t.after(async () => closeQuietly(server));
  server = await createProbeSocketServer({
    socketPath,
    privateRoot: root,
    trustedBoundary: root,
    ownership: () => true,
    receiver: { request: async (request) => helloReply(request) },
  });
  const socket = net.createConnection({ path: socketPath });
  t.after(() => socket.destroy());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await once(socket, 'connect');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(262_145, 0);
  socket.write(header);
  await once(socket, 'close');
  assert.equal(socket.readableEnded || socket.destroyed, true);
});

test('lost server port permanently rejects a pending client request', { timeout: 2_000 }, async (t) => {
  const { root, socketPath } = rootFixture();
  let server;
  let client;
  t.after(async () => {
    await closeQuietly(client);
    await closeQuietly(server);
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  server = await createProbeSocketServer({
    socketPath,
    privateRoot: root,
    trustedBoundary: root,
    ownership: () => true,
    requestTimeoutMs: 5_000,
    receiver: { request: async () => new Promise(() => {}) },
  });
  client = await connectProbeSocket({
    socketPath,
    privateRoot: root,
    trustedBoundary: root,
    requestTimeoutMs: 5_000,
  });
  const pending = client.request(hello());
  await new Promise((resolve) => setImmediate(resolve));
  await server.close();
  await assert.rejects(pending, (error) => error instanceof ProbeSocketError
    && ['connection_lost', 'connection_closed'].includes(error.code));
  await assert.rejects(client.request(hello(id2)), (error) => error instanceof ProbeSocketError
    && error.code === 'connection_closed');
});

test('second connection is denied while one connection is active', async (t) => {
  const { root, socketPath } = rootFixture();
  let server;
  let client;
  let second;
  t.after(async () => {
    if (second) second.destroy();
    await closeQuietly(client);
    await closeQuietly(server);
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  server = await createProbeSocketServer({
    socketPath,
    privateRoot: root,
    trustedBoundary: root,
    ownership: () => true,
    receiver: { request: async (request) => helloReply(request) },
  });
  client = await connectProbeSocket({
    socketPath,
    privateRoot: root,
    trustedBoundary: root,
  });
  second = net.createConnection({ path: socketPath });
  await once(second, 'connect');
  await once(second, 'close');
  assert.equal((await client.request(hello())).request_id, id1);
});

test('path checks reject unsafe leaves without mutation', async (t) => {
  const { root, socketPath } = rootFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const regular = join(root, 'regular');
  writeFileSync(regular, 'sentinel', { mode: 0o600 });
  await assert.rejects(
    createProbeSocketServer({
      socketPath: regular,
      privateRoot: root,
      trustedBoundary: root,
      ownership: () => true,
      receiver: { request: async (request) => helloReply(request) },
    }),
    (error) => error instanceof ProbeSocketError && error.code === 'socket_wrong_type',
  );
  assert.equal(lstatSync(regular).isFile(), true);

  const linked = join(root, 'linked');
  symlinkSync(regular, linked);
  await assert.rejects(
    connectProbeSocket({
      socketPath: linked,
      privateRoot: root,
      trustedBoundary: root,
    }),
    (error) => error instanceof ProbeSocketError && error.code === 'socket_symlink',
  );
  unlinkSync(linked);

});

test('socket paths reject control characters and overlong UTF-8 byte names', async (t) => {
  const { root } = rootFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const receiver = { request: async (request) => helloReply(request) };
  await assert.rejects(
    createProbeSocketServer({
      socketPath: join(root, 'bad\npath.sock'),
      privateRoot: root,
      trustedBoundary: root,
      ownership: () => true,
      receiver,
    }),
    (error) => error instanceof ProbeSocketError && error.code === 'unsafe_path',
  );
  await assert.rejects(
    connectProbeSocket({
      socketPath: join(root, 'é'.repeat(60)),
      privateRoot: root,
      trustedBoundary: root,
    }),
    (error) => error instanceof ProbeSocketError && error.code === 'unsafe_path',
  );
});

test('private parent and socket modes are enforced before serving', async (t) => {
  const { root, socketPath } = rootFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o755);
  await assert.rejects(
    createProbeSocketServer({
      socketPath,
      privateRoot: root,
      trustedBoundary: root,
      ownership: () => true,
      receiver: { request: async (request) => helloReply(request) },
    }),
    (error) => error instanceof ProbeSocketError && error.code === 'unsafe_path',
  );
  chmodSync(root, 0o700);

  const raw = net.createServer();
  await new Promise((resolve, reject) => {
    raw.once('error', reject);
    raw.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o644);
  await assert.rejects(
    createProbeSocketServer({
      socketPath,
      privateRoot: root,
      trustedBoundary: root,
      ownership: () => true,
      receiver: { request: async (request) => helloReply(request) },
    }),
    (error) => error instanceof ProbeSocketError && error.code === 'socket_unsafe_mode',
  );
  await new Promise((resolve) => raw.close(resolve));
});

test('wrong replies and receiver timeouts permanently close the connector', { timeout: 2_000 }, async (t) => {
  const first = rootFixture();
  const second = rootFixture();
  t.after(() => rmSync(first.root, { recursive: true, force: true }));
  t.after(() => rmSync(second.root, { recursive: true, force: true }));
  let wrongServer;
  let wrongClient;
  wrongServer = await createProbeSocketServer({
    socketPath: first.socketPath,
    privateRoot: first.root,
    trustedBoundary: first.root,
    ownership: () => true,
    receiver: { request: async (request) => helloReply({ ...request, request_id: id2 }) },
  });
  wrongClient = await connectProbeSocket({
    socketPath: first.socketPath,
    privateRoot: first.root,
    trustedBoundary: first.root,
  });
  await assert.rejects(wrongClient.request(hello()), (error) => error instanceof ProbeSocketError
    && error.code === 'connection_lost');
  await assert.rejects(wrongClient.request(hello(id2)), (error) => error instanceof ProbeSocketError
    && error.code === 'connection_closed');
  await closeQuietly(wrongClient);
  await closeQuietly(wrongServer);

  let timeoutServer;
  let timeoutClient;
  let calls = 0;
  let cancelled = false;
  timeoutServer = await createProbeSocketServer({
    socketPath: second.socketPath,
    privateRoot: second.root,
    trustedBoundary: second.root,
    ownership: () => true,
    requestTimeoutMs: 50,
    receiver: { request: async (_request, { signal }) => {
      calls += 1;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => { cancelled = true; reject(new Error('synthetic_abort')); }, { once: true });
      });
    } },
  });
  timeoutClient = await connectProbeSocket({
    socketPath: second.socketPath,
    privateRoot: second.root,
    trustedBoundary: second.root,
    requestTimeoutMs: 100,
  });
  await assert.rejects(timeoutClient.request(hello()), (error) => error instanceof ProbeSocketError
    && ['connection_lost', 'timeout'].includes(error.code));
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  const denied = net.createConnection({ path: second.socketPath });
  const deniedClosed = once(denied, 'close');
  await once(denied, 'connect');
  await deniedClosed;
  assert.equal(calls, 1, 'timed-out receiver fences the listener, not just its old client');
  await assert.rejects(timeoutClient.request(hello(id2)), (error) => error instanceof ProbeSocketError
    && error.code === 'connection_closed');
  await closeQuietly(timeoutClient);
  await closeQuietly(timeoutServer);
});

test('server emits no frame for a mismatched receiver reply ID', async (t) => {
  const { root, socketPath } = rootFixture();
  let server;
  let socket;
  t.after(async () => {
    socket?.destroy();
    await closeQuietly(server);
    rmSync(root, { recursive: true, force: true });
  });
  server = await createProbeSocketServer({ socketPath, privateRoot: root, trustedBoundary: root,
    ownership: () => true, receiver: { request: (request) => helloReply({ ...request, request_id: id2 }) } });
  socket = net.createConnection({ path: socketPath });
  await once(socket, 'connect');
  let bytes = 0;
  socket.on('data', (chunk) => { bytes += chunk.length; });
  const closed = once(socket, 'close');
  const { encodeNativeMessage } = await import('../src/framing.mjs');
  const { assertRequest } = await import('../src/contracts.mjs');
  socket.write(encodeNativeMessage(hello(), assertRequest));
  await closed;
  assert.equal(bytes, 0);
});

test('socket source contains escaped patterns, not binary control characters', () => {
  const source = readFileSync(new URL('../src/probe-socket.mjs', import.meta.url));
  assert.equal([...source].some((byte) => (byte < 32 && ![9, 10, 13].includes(byte)) || byte === 127), false);
});

test('server close rechecks caller ownership before unlinking its socket', async (t) => {
  const { root, socketPath } = rootFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let owns = true;
  const server = await createProbeSocketServer({
    socketPath,
    privateRoot: root,
    trustedBoundary: root,
    ownership: () => owns,
    receiver: { request: async (request) => helloReply(request) },
  });
  owns = false;
  await assert.rejects(server.close(), (error) => error instanceof ProbeSocketError
    && error.code === 'ownership_not_held');
  assert.equal(lstatSync(socketPath).isSocket(), true);
  owns = true;
  await server.close();
  assert.throws(() => lstatSync(socketPath), { code: 'ENOENT' });
});

test('stale socket cleanup requires caller-held ownership', async (t) => {
  const { root, socketPath } = rootFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const raw = net.createServer();
  await new Promise((resolve, reject) => {
    raw.once('error', reject);
    raw.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  await assert.rejects(
    createProbeSocketServer({
      socketPath,
      privateRoot: root,
      trustedBoundary: root,
      ownership: () => false,
      receiver: { request: async (request) => helloReply(request) },
    }),
    (error) => error instanceof ProbeSocketError && error.code === 'ownership_not_held',
  );
  assert.equal(lstatSync(socketPath).isSocket(), true);
  await new Promise((resolve) => raw.close(resolve));
});
