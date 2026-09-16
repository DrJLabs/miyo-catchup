import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { spawnOwnedProcess, ownershipResult } from '../src/ownership.mjs';
import { runNativeHostEntry, readNativeHostConfiguration } from '../src/native-host-entry.mjs';
import { connectProbeSocket } from '../src/probe-socket.mjs';
import { encodeNativeMessage, NativeFrameDecoder } from '../src/framing.mjs';
import { assertReply, assertRequest } from '../src/contracts.mjs';

function ready(child) {
  return new Promise((resolveReady, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exit);
      child.off('error', failure);
      if (error) reject(error); else resolveReady();
    };
    const message = (value) => { if (value === 'ready') finish(); };
    const exit = () => finish(new Error('synthetic_child_exited'));
    const failure = () => finish(new Error('synthetic_child_failed'));
    const timer = setTimeout(() => finish(new Error('synthetic_child_timeout')), 5000);
    child.on('message', message).once('exit', exit).once('error', failure);
  });
}

test('flock-owned subprocess + private socket + native entry round-trip and crash fencing', { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'miyo-t02-process-'));
  const socketPath = join(root, 'probe.sock');
  const children = [];
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const launch = () => {
    const child = spawnOwnedProcess({ lockPath: join(root, 'owner.lock'), executable: process.execPath,
      args: [resolve('tests/fixtures/probe-socket-child.mjs'), root], trustedBoundary: root,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const value = { child, exited: ownershipResult(child) };
    children.push(value);
    return value;
  };
  const first = launch();
  await ready(first.child);
  const original = lstatSync(socketPath);
  assert.equal(original.mode & 0o777, 0o600);
  const second = launch();
  assert.equal((await second.exited).code, 1);
  assert.equal(lstatSync(socketPath).ino, original.ino, 'contender must not remove live owner socket');

  const configPath = join(root, 'host.json');
  const extensionId = 'a'.repeat(32);
  writeFileSync(configPath, JSON.stringify({ version: 1, extension_id: extensionId, socket_path: socketPath }), { mode: 0o600 });
  const input = new PassThrough();
  const output = new PassThrough();
  // Real reader and connector, with only the explicit synthetic-root trust
  // exception; no mocked transport, role assertion or client-held worker lock.
  const host = runNativeHostEntry({ args: [configPath, `chrome-extension://${extensionId}/`], input, output,
    readConfiguration: (path) => readNativeHostConfiguration(path, { trustedBoundary: root }),
    connect: (options) => connectProbeSocket({ ...options, trustedBoundary: root }) });
  // Observe failure immediately while waiting for the bounded reply.
  host.catch(() => {});
  const id = '11111111-1111-4111-8111-111111111111';
  const request = { protocol_version: 1, request_id: id, operation: 'hello',
    payload: { extension_version: '0.0.0', browser_instance_id: id, capabilities: ['session_check', 'chunking'] } };
  const received = once(output, 'data', { signal: AbortSignal.timeout(5000) });
  input.write(encodeNativeMessage(request, assertRequest));
  const [bytes] = await Promise.race([received, host.then(() => { throw new Error('native_host_ended_before_reply'); })]);
  const replies = [];
  const decoder = new NativeFrameDecoder((reply) => assertReply(reply, 'hello'));
  await decoder.consume(bytes, (reply) => { replies.push(reply); });
  decoder.finish();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].request_id, id);
  assert.equal(replies[0].ok, true);
  input.end();
  await host;

  first.child.kill('SIGKILL');
  assert.equal((await first.exited).signal, 'SIGKILL');
  assert.equal(existsSync(socketPath), true, 'crash evidence remains until a new locked owner starts');
  const replacement = launch();
  await ready(replacement.child);
  assert.equal(lstatSync(socketPath).isSocket(), true);
  replacement.child.send('stop');
  assert.equal((await replacement.exited).code, 0);
  assert.equal(existsSync(socketPath), false);
});
