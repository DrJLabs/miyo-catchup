import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { assertReply } from '../src/contracts.mjs';
import { connectProbeSocket } from '../src/probe-socket.mjs';
import { ownershipResult, spawnOwnedProcess } from '../src/ownership.mjs';
import {
  readSetupInspectionConfiguration,
  runSetupInspectionEntry,
  runSetupInspectionOwner,
} from '../src/setup-inspection-entry.mjs';
import { temporaryRoot } from './helpers/harness.mjs';

const CHILD = resolve('tests/fixtures/setup-inspection-child.mjs');
const extensionId = 'a'.repeat(32);
const binding = {
  binding_id: 'setup-binding', principal_id: 'setup-principal',
  context_id: null, account_id: 'setup-principal',
};

function writeFixture(t) {
  const root = temporaryRoot(t);
  const runtime = join(root, 'runtime');
  const staging = join(root, 'staging');
  mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(staging, { mode: 0o700 });
  const socketPath = join(runtime, 'setup.sock');
  const nativePath = join(runtime, 'host.json');
  const setupPath = join(runtime, 'setup.json');
  writeFileSync(nativePath, JSON.stringify({ version: 1, extension_id: extensionId, socket_path: socketPath }), { mode: 0o600 });
  writeFileSync(setupPath, JSON.stringify({ version: 1, native_host_config: nativePath,
    root: staging, binding, conversation_id: 'selected-conversation' }), { mode: 0o600 });
  return { root, runtime, staging, socketPath, nativePath, setupPath };
}

async function waitForSocket(path, root, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await connectProbeSocket({ socketPath: path, trustedBoundary: root, connectTimeoutMs: 100, requestTimeoutMs: 1000 }); }
    catch { await new Promise((resolveWait) => setTimeout(resolveWait, 20)); }
  }
  throw new Error('setup_inspection_socket_timeout');
}

function launchFixture(fixture, mode) {
  const child = spawnOwnedProcess({
    lockPath: join(fixture.runtime, 'connection-check.lock'),
    executable: process.execPath,
    args: [CHILD, fixture.root, fixture.setupPath, ...(mode ? [mode] : [])],
    trustedBoundary: fixture.root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, exited: ownershipResult(child) };
}

function requestFactory(connector) {
  let serial = 0;
  return (operation, payload, fence = {}) => {
    const request = { protocol_version: 1,
      request_id: `11111111-1111-4111-8111-${String(++serial).padStart(12, '0')}`,
      operation, payload, ...fence };
    return connector.request(request);
  };
}

test('setup configuration is exact, private and separately pins native host config', async (t) => {
  const fixture = writeFixture(t);
  const config = readSetupInspectionConfiguration(fixture.setupPath, { trustedBoundary: fixture.root });
  assert.equal(config.root, fixture.staging);
  assert.equal(config.socket_path, fixture.socketPath);
  assert.deepEqual(config.binding, binding);
  assert.equal(config.conversation_id, 'selected-conversation');

  writeFileSync(fixture.setupPath, JSON.stringify({ ...config, socket_path: undefined }), { mode: 0o600 });
  assert.throws(() => readSetupInspectionConfiguration(fixture.setupPath, { trustedBoundary: fixture.root }), { message: 'invalid_setup_configuration' });
});

test('setup inspection completes one session-only native roundtrip and refuses body work', { timeout: 15000 }, async (t) => {
  const fixture = writeFixture(t);
  const launch = launchFixture(fixture);
  t.after(async () => {
    if (launch.child.exitCode === null && launch.child.signalCode === null) launch.child.kill('SIGTERM');
    await launch.exited;
  });
  const connector = await waitForSocket(fixture.socketPath, fixture.root);
  t.after(() => connector.close());
  const request = requestFactory(connector);
  const helloId = '22222222-2222-4222-8222-222222222222';
  const hello = await connector.request({ protocol_version: 1, request_id: helloId, operation: 'hello',
    payload: { extension_version: '0.0.0', browser_instance_id: '33333333-3333-4333-8333-333333333333', capabilities: ['session_check', 'chunking'] } });
  assertReply(hello, 'hello');
  const browser = '33333333-3333-4333-8333-333333333333';
  const claimed = await request('claim_work', { browser_instance_id: browser, principal_id: null, context_id: null });
  assertReply(claimed, 'claim_work');
  const lease = claimed.result.lease;
  const fence = { run_id: lease.run_id, attempt_id: lease.attempt_id, lease_generation: lease.lease_generation };
  const permit = await request('request_permit', { work_unit_id: 'session-check' }, fence);
  assertReply(permit, 'request_permit');
  assert.equal(permit.result.request_kind, 'session_check');
  const permitFence = { ...fence, permit_id: permit.result.permit_id };
  const documentId = 'setup-document';
  const started = await request('dispatch_started', { browser_instance_id: browser, document_id: documentId }, permitFence);
  assertReply(started, 'dispatch_started');
  const data = Buffer.from(JSON.stringify({ principal_id: binding.principal_id, context_id: 'personal-context' }));
  const chunk = await request('result_chunk', { sequence: 0, decoded_bytes: data.length, data: data.toString('base64') }, permitFence);
  assertReply(chunk, 'result_chunk');
  const receipt = await request('commit_result', { chunk_count: 1, raw_bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex') }, permitFence);
  assertReply(receipt, 'commit_result');
  assert.equal(receipt.ok, true);
  await connector.close();
  launch.child.kill('SIGTERM');
  const result = await launch.exited;
  assert.equal(result.code, 0);
  assert.equal(existsSync(fixture.socketPath), false);
  assert.equal(lstatSync(join(fixture.staging, 'probe-state.db')).isFile(), true);
});

test('setup owner rejects an unlocked or malformed configuration before serving', async (t) => {
  const fixture = writeFixture(t);
  writeFileSync(join(fixture.runtime, 'connection-check.lock'), '', { mode: 0o600 });
  await assert.rejects(runSetupInspectionOwner({ configPath: fixture.setupPath,
    trustedBoundary: fixture.root, lifetimeMs: 1000 }), { message: 'ownership_unproven' });
  writeFileSync(fixture.setupPath, '{"version":1}', { mode: 0o600 });
  assert.throws(() => readSetupInspectionConfiguration(fixture.setupPath, { trustedBoundary: fixture.root }), { message: 'invalid_setup_configuration' });
});

test('setup entry keeps the launcher signal handlers bounded and uses the explicit config only', async () => {
  const signals = [];
  let finish;
  const childDone = new Promise((resolve) => { finish = resolve; });
  const running = runSetupInspectionEntry({
    args: ['/synthetic/setup.json'],
    readConfiguration: () => ({ socket_path: '/synthetic/setup.sock' }),
    spawn: () => ({ kill: (signal) => signals.push(signal) }),
    wait: () => childDone,
    entryPath: '/synthetic/setup-entry.mjs',
  });
  process.emit('SIGTERM');
  process.emit('SIGTERM');
  try { assert.deepEqual(signals, ['SIGTERM']); }
  finally { finish({ code: 0, signal: null }); await running; }
});

test('setup CLI emits fixed stderr and no stdout on invalid input', () => {
  const result = spawnSync(process.execPath, ['src/setup-inspection-entry.mjs', '/missing/SYNTHETIC_PRIVATE'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'miyo-catchup: setup inspection unavailable\n');
});
