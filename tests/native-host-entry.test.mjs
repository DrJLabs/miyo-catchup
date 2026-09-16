import assert from 'node:assert/strict';
import { chmodSync, linkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { readNativeHostConfiguration, runNativeHostEntry } from '../src/native-host-entry.mjs';
import { nativeHostLauncher } from '../install/native-host-launcher.mjs';
import { temporaryRoot } from './helpers/harness.mjs';

const extensionId = 'a'.repeat(32);
const origin = `chrome-extension://${extensionId}/`;

function fixture(t) {
  const root = temporaryRoot(t);
  const path = join(root, 'host.json');
  const config = { version: 1, extension_id: extensionId, socket_path: join(root, 'probe.sock') };
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return { root, path, config, read: () => readNativeHostConfiguration(path, { trustedBoundary: root }) };
}

test('native entry reads a closed, bounded private configuration without defaults', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.read(), f.config);
  for (const change of [{ version: 2 }, { token: 'SYNTHETIC_SECRET' }, { extension_id: '*' },
    { socket_path: '../relative' }, { socket_path: '/unsafe\npath' }]) {
    writeFileSync(f.path, JSON.stringify({ ...f.config, ...change }));
    assert.throws(f.read, { message: 'invalid_host_configuration' });
  }
  writeFileSync(f.path, ' '.repeat(16385));
  assert.throws(f.read, { message: 'invalid_host_configuration' });
  writeFileSync(f.path, Buffer.from([0xff]));
  assert.throws(f.read, { message: 'invalid_host_configuration' });
});

test('native entry rejects public, linked and unsafe-ancestor configuration', (t) => {
  const f = fixture(t);
  chmodSync(f.path, 0o644);
  assert.throws(f.read, { message: 'invalid_host_configuration' });
  chmodSync(f.path, 0o600);
  chmodSync(f.root, 0o755);
  assert.throws(f.read, { message: 'invalid_host_configuration' });
  chmodSync(f.root, 0o700);
  symlinkSync(f.path, join(f.root, 'alias.json'));
  assert.throws(() => readNativeHostConfiguration(join(f.root, 'alias.json'), { trustedBoundary: f.root }));
  linkSync(f.path, join(f.root, 'hard.json'));
  assert.throws(f.read, { message: 'invalid_host_configuration' });
  // Omitting the synthetic exception rejects /tmp ancestors in real use.
  assert.throws(() => readNativeHostConfiguration(f.path), { message: 'invalid_host_configuration' });
});

test('invocation and origin rejection precede connection; no alternate config flags', async () => {
  let reads = 0;
  let connects = 0;
  const options = { input: new PassThrough(), output: new PassThrough(),
    readConfiguration: () => { reads += 1; return { extension_id: extensionId, socket_path: '/synthetic/probe.sock' }; },
    connect: () => { connects += 1; throw new Error('SYNTHETIC_PRIVATE_ERROR'); } };
  for (const args of [[], ['/synthetic/config', origin, 'extra'], ['/synthetic/config', `${origin}path`]]) {
    await assert.rejects(runNativeHostEntry({ ...options, args }), { message: 'invalid_host_invocation' });
  }
  await assert.rejects(runNativeHostEntry({ ...options, args: ['/synthetic/config', origin], runtimeVersion: 'v24.0.0' }));
  assert.equal(reads, 0);
  await assert.rejects(runNativeHostEntry({ ...options,
    args: ['/synthetic/config', `chrome-extension://${'b'.repeat(32)}/`] }), { code: 'unauthorized_origin' });
  assert.equal(connects, 0);
  await assert.rejects(runNativeHostEntry({ ...options, args: ['/synthetic/config', origin] }), { code: 'worker_unavailable' });
  assert.equal(connects, 1);
});

test('launcher pins literal paths and forwards Chrome argv without shell interpolation', (t) => {
  const root = temporaryRoot(t);
  const entryPath = join(root, "entry ' $quoted.mjs");
  const configurationPath = join(root, "config ' $(never).json");
  const launcher = nativeHostLauncher({ nodePath: process.execPath, entryPath, configurationPath });
  writeFileSync(entryPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o600 });
  const path = join(root, 'launcher');
  writeFileSync(path, launcher, { mode: 0o700 });
  const result = spawnSync(path, [origin], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [configurationPath, origin]);
  for (const nodePath of ['node', '/node\ncommand', '/', '/a/../node']) {
    assert.throws(() => nativeHostLauncher({ nodePath, entryPath, configurationPath }));
  }
});

test('entrypoint failure emits fixed stderr and no unframed stdout', () => {
  const result = spawnSync(process.execPath, ['src/native-host-entry.mjs', '/missing/SYNTHETIC_PRIVATE', origin],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'miyo-catchup: native host unavailable\n');
});
