import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { connectProbeSocket } from '../src/probe-socket.mjs';
import { assertReply } from '../src/contracts.mjs';
import { spawnOwnedProcess, ownershipResult } from '../src/ownership.mjs';
import { runConnectionCheckEntry, runConnectionCheckOwner } from '../src/connection-check-entry.mjs';
import { temporaryRoot } from './helpers/harness.mjs';

const CHILD = resolve('tests/fixtures/connection-check-child.mjs');
const extensionId = 'a'.repeat(32);

async function waitForSocket(path, root, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const connector = await connectProbeSocket({ socketPath: path, trustedBoundary: root, connectTimeoutMs: 100 });
      return connector;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error('connection_check_socket_timeout');
}

test('foreground connection check serves status under real flock and fences competitors', { timeout: 15000 }, async (t) => {
  const root = temporaryRoot(t);
  const runtime = join(root, 'runtime');
  mkdirSync(runtime, { mode: 0o700 });
  const socketPath = join(runtime, 'check.sock');
  const configPath = join(runtime, 'host.json');
  writeFileSync(configPath, JSON.stringify({ version: 1, extension_id: extensionId, socket_path: socketPath }), { mode: 0o600 });
  const lockPath = join(runtime, 'connection-check.lock');
  const launch = () => {
    const child = spawnOwnedProcess({
      lockPath,
      executable: process.execPath,
      args: [CHILD, root, configPath],
      trustedBoundary: root,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return { child, exited: ownershipResult(child) };
  };
  const first = launch();
  t.after(async () => {
    if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill('SIGTERM');
    await first.exited;
  });
  let connector;
  try {
    connector = await waitForSocket(socketPath, root);
    const id = '11111111-1111-4111-8111-111111111111';
    const reply = await connector.request({ protocol_version: 1, request_id: id, operation: 'get_status', payload: {} });
    assertReply(reply, 'get_status');
    assert.equal(reply.ok, true);
    assert.equal(reply.result.status.worker_version, '0.0.0-t02-connection');
    assert.equal(reply.result.status.connectivity, 'available');
    assert.equal(reply.result.status.liveness, 'live');
    await connector.close();
    connector = null;

    const originalSocket = lstatSync(socketPath);
    const second = launch();
    assert.equal((await second.exited).code, 1);
    assert.equal(lstatSync(socketPath).ino, originalSocket.ino);
  } finally {
    await connector?.close().catch(() => {});
  }
  first.child.kill('SIGTERM');
  const result = await first.exited;
  assert.equal(result.code, 0);
  assert.equal(existsSync(socketPath), false);
});

test('foreground entry rejects unpinned runtime and malformed argument sets before spawning', async () => {
  const entry = await import('../src/connection-check-entry.mjs');
  let reads = 0;
  let starts = 0;
  const options = {
    args: ['/synthetic/config'],
    readConfiguration: () => { reads += 1; return { socket_path: '/synthetic/check.sock' }; },
    spawn: () => { starts += 1; throw new Error('must_not_spawn'); },
  };
  await assert.rejects(entry.runConnectionCheckEntry({ ...options, runtimeVersion: 'v23.0.0' }), { message: 'invalid_connection_check_invocation' });
  for (const args of [[], ['/one', '/two']]) {
    await assert.rejects(entry.runConnectionCheckEntry({ ...options, args }), { message: 'invalid_connection_check_invocation' });
  }
  assert.equal(reads, 0);
  assert.equal(starts, 0);
});

test('owner rejects an open but unlocked lock file', async (t) => {
  const root = temporaryRoot(t);
  const runtime = join(root, 'runtime');
  mkdirSync(runtime, { mode: 0o700 });
  const socketPath = join(runtime, 'check.sock');
  const configPath = join(runtime, 'host.json');
  const lockPath = join(runtime, 'connection-check.lock');
  writeFileSync(configPath, JSON.stringify({ version: 1, extension_id: extensionId, socket_path: socketPath }), { mode: 0o600 });
  writeFileSync(lockPath, '', { mode: 0o600 });
  await assert.rejects(runConnectionCheckOwner({ configPath, trustedBoundary: root, lifetimeMs: 1000 }), { message: 'ownership_unproven' });
});

test('entry module emits fixed stderr and no stdout on missing configuration', () => {
  const result = spawnSync(process.execPath, ['src/connection-check-entry.mjs', '/missing/SYNTHETIC_PRIVATE'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'miyo-catchup: connection check unavailable\n');
});

test('owner tolerates a repeated terminal signal until socket cleanup completes', { timeout: 10000 }, async (t) => {
  const root = temporaryRoot(t);
  const runtime = join(root, 'runtime');
  mkdirSync(runtime, { mode: 0o700 });
  const socketPath = join(runtime, 'check.sock');
  const configPath = join(runtime, 'host.json');
  writeFileSync(configPath, JSON.stringify({ version: 1, extension_id: extensionId, socket_path: socketPath }), { mode: 0o600 });
  const child = spawnOwnedProcess({
    lockPath: join(runtime, 'connection-check.lock'), executable: process.execPath,
    args: [CHILD, root, configPath, 'delayed-close'], trustedBoundary: root,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = ownershipResult(child);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const connector = await waitForSocket(socketPath, root);
  await connector.close();
  const closing = once(child.stdout, 'data');
  child.kill('SIGINT');
  assert.equal(String((await closing)[0]), 'closing\n');
  child.kill('SIGINT');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(existsSync(socketPath), false);
});

test('launcher forwards only the first signal and retains handlers until its child exits', async () => {
  const original = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
  const signals = [];
  let finish;
  const childDone = new Promise((resolve) => { finish = resolve; });
  const running = runConnectionCheckEntry({
    args: ['/synthetic/config'],
    readConfiguration: () => ({ socket_path: '/synthetic/check.sock' }),
    spawn: () => ({ kill: (signal) => { signals.push(signal); } }),
    wait: () => childDone,
  });
  try {
    process.emit('SIGINT');
    process.emit('SIGINT');
    process.emit('SIGTERM');
    assert.deepEqual(signals, ['SIGINT']);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      assert.equal(process.listenerCount(signal), original[signal] + 1);
    }
  } finally {
    finish({ code: 0, signal: null });
    await running;
  }
  for (const signal of ['SIGINT', 'SIGTERM']) assert.equal(process.listenerCount(signal), original[signal]);
});
