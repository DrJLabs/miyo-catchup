import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  UnsafePathError,
  assertContainedPath,
  assertSafePath,
  createPrivateFile,
  ensurePrivateDirectory,
  normalizeAbsolutePath,
} from '../src/safe-paths.mjs';
import { spawnOwnedProcess } from '../src/ownership.mjs';

const REPOSITORY = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'miyo-catchup-safety-anchor-'));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('safe paths require absolute normalized names and explicit containment', (t) => {
  const root = fixture(t);
  assert.throws(() => normalizeAbsolutePath(`${root}/a/../b`), /traversal/);
  assert.throws(() => normalizeAbsolutePath(`${root}//b`), /traversal/);
  assert.throws(() => normalizeAbsolutePath('relative/file'), UnsafePathError);
  assert.throws(() => normalizeAbsolutePath(`${root}/bad\0name`), UnsafePathError);
  assert.throws(() => assertContainedPath('/etc/passwd', root), /outside root/);

  const nested = join(root, 'nested');
  ensurePrivateDirectory(nested, { trustedBoundary: root });
  const file = join(nested, 'state.db');
  assert.equal(createPrivateFile(file, { trustedBoundary: root }), true);
  assert.equal(assertSafePath(file, {
    expectedType: 'file', privateMode: true, trustedBoundary: root,
  }), file);
});

test('unsafe ancestors and symlinks fail closed', (t) => {
  const root = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'miyo-catchup-safety-outside-'));
  chmodSync(outside, 0o700);
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret'), 'synthetic\n', { mode: 0o600 });
  symlinkSync(outside, join(root, 'linked'));
  assert.throws(() => assertSafePath(join(root, 'linked', 'secret'), {
    expectedType: 'file', trustedBoundary: root,
  }), /symbolic link/);

  // The world-writable system temporary directory is deliberately outside the
  // test trust boundary and remains rejected by production-style validation.
  assert.throws(() => assertSafePath('/tmp/miyo-catchup-unsafe/state.db', {
    expectedType: 'file', allowMissingLeaf: true,
  }), /writable/);
});

test('private files reject hard links and group/other writable modes', (t) => {
  const root = fixture(t);
  const file = join(root, 'state.db');
  const alias = join(root, 'state-alias.db');
  writeFileSync(file, 'synthetic\n', { mode: 0o600 });
  linkSync(file, alias);
  assert.throws(() => assertSafePath(file, {
    expectedType: 'file', privateMode: true, trustedBoundary: root,
  }), /hard links/);
  rmSync(alias);
  chmodSync(file, 0o640);
  assert.throws(() => assertSafePath(file, {
    expectedType: 'file', privateMode: true, trustedBoundary: root,
  }), /0600/);
});

test('wrong owner and wrong type fail closed without changing synthetic data', (t) => {
  const root = fixture(t);
  const file = join(root, 'owned.txt');
  writeFileSync(file, 'owner sentinel\n', { mode: 0o600 });
  const otherUid = typeof process.getuid === 'function' ? process.getuid() + 1 : 99_999;
  assert.throws(() => assertSafePath(file, {
    expectedType: 'file', privateMode: true, trustedBoundary: root, ownerUid: otherUid,
  }), /owner/);
  assert.equal(readFileSync(file, 'utf8'), 'owner sentinel\n');
  assert.throws(() => assertSafePath(root, {
    expectedType: 'file', trustedBoundary: root,
  }), /regular file/);
  assert.throws(() => assertSafePath(file, {
    expectedType: 'directory', trustedBoundary: root,
  }), /directory/);
});

test('missing parents cannot be smuggled through a missing intermediate path', (t) => {
  const root = fixture(t);
  assert.throws(() => assertSafePath(join(root, 'missing', 'leaf'), {
    expectedType: 'file', allowMissingLeaf: true, trustedBoundary: root,
  }), /missing parent/);
  mkdirSync(join(root, 'present'));
  assert.equal(assertSafePath(join(root, 'present', 'leaf'), {
    expectedType: 'file', allowMissingLeaf: true, trustedBoundary: root,
  }), join(root, 'present', 'leaf'));
});

test('private creation helpers reject invalid modes before creating artifacts', (t) => {
  const root = fixture(t);
  const directory = join(root, 'bad-directory');
  const file = join(root, 'bad-file');
  assert.throws(() => ensurePrivateDirectory(directory, { trustedBoundary: root, mode: 0o755 }),
    /0700/);
  assert.throws(() => createPrivateFile(file, { trustedBoundary: root, mode: 0o644 }),
    /0600/);
  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(file), false);
});

test('ownership validates the command before creating its lock artifact', (t) => {
  const root = fixture(t);
  const lockPath = join(root, 'invalid.lock');
  assert.throws(() => spawnOwnedProcess({
    lockPath,
    executable: process.execPath,
    args: [null],
    trustedBoundary: root,
    stdio: 'ignore',
  }), /args/);
  assert.equal(existsSync(lockPath), false);
});
