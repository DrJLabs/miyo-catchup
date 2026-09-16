import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { spawnOwnedProcess, ownershipResult } from '../src/ownership.mjs';
import {
  assertDurablePolicy,
  durableBackup,
  openDurableDatabase,
  transaction,
} from '../src/sqlite.mjs';

const REPOSITORY = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CHILD = join(REPOSITORY, 'tests', 'fixtures', 'durability-child.mjs');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'miyo-catchup-durability-anchor-'));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function waitFor(pathname, timeoutMs = 3_000) {
  const started = Date.now();
  while (!existsSync(pathname)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${pathname}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function spawnChild(args) {
  return spawn(process.execPath, [CHILD, ...args], {
    cwd: REPOSITORY,
    stdio: 'ignore',
    shell: false,
  });
}

test('SQLite applies the full durable policy and transaction outcomes survive restart', async (t) => {
  const root = fixture(t);
  const dbPath = join(root, 'state.db');
  const db = openDurableDatabase({ path: dbPath, root, trustedBoundary: root, busyTimeoutMs: 100 });
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  assert.deepEqual(assertDurablePolicy(db), {
    journalMode: 'wal', synchronous: 2, foreignKeys: 1, trustedSchema: 0,
  });
  assert.throws(() => db.loadExtension('/definitely/not/a/real/extension.so'));
  transaction(db, (connection) => {
    connection.prepare('INSERT INTO events (value) VALUES (?)').run('committed-inline');
  });
  let asyncInvoked = false;
  assert.throws(() => transaction(db, async () => {
    asyncInvoked = true;
    return 'unsupported';
  }), /synchronous/);
  assert.equal(asyncInvoked, false);
  assert.throws(() => transaction(db, () => Promise.resolve('unsupported')), /synchronous/);
  db.close();

  const uncommittedReady = join(root, 'uncommitted.ready');
  const uncommitted = spawnChild([
    '--action', 'uncommitted-transaction', '--db', dbPath,
    '--root', root, '--value', 'must-rollback', '--ready', uncommittedReady,
  ]);
  t.after(() => { if (uncommitted.exitCode === null) uncommitted.kill('SIGKILL'); });
  await waitFor(uncommittedReady);
  uncommitted.kill('SIGKILL');
  await new Promise((resolve) => uncommitted.once('exit', resolve));

  const afterCrash = openDurableDatabase({ path: dbPath, root, trustedBoundary: root });
  assert.deepEqual(afterCrash.prepare('SELECT value FROM events ORDER BY id').all().map((row) => ({ ...row })), [
    { value: 'committed-inline' },
  ]);
  afterCrash.close();

  const committedReady = join(root, 'committed.ready');
  const committed = spawnChild([
    '--action', 'committed-transaction', '--db', dbPath,
    '--root', root, '--value', 'committed-child', '--ready', committedReady,
  ]);
  const committedExit = new Promise((resolve, reject) => {
    committed.once('error', reject);
    committed.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(() => { if (committed.exitCode === null) committed.kill('SIGKILL'); });
  await waitFor(committedReady);
  committed.kill('SIGKILL');
  const committedResult = await committedExit;
  assert.equal(committedResult.signal, 'SIGKILL');
  const afterCommit = openDurableDatabase({ path: dbPath, root, trustedBoundary: root });
  assert.deepEqual(afterCommit.prepare('SELECT value FROM events ORDER BY id').all().map((row) => ({ ...row })), [
    { value: 'committed-inline' }, { value: 'committed-child' },
  ]);
  afterCommit.close();
});

test('pre-existing SQLite sidecars are preflighted before any probe or backup write', async (t) => {
  const root = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'miyo-catchup-durability-sidecar-sentinel-'));
  chmodSync(outside, 0o700);
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const dbPath = join(root, 'state.db');
  const db = openDurableDatabase({ path: dbPath, root, trustedBoundary: root });
  db.exec('CREATE TABLE events (value TEXT NOT NULL)');
  db.close();
  const sentinel = join(outside, 'sentinel');
  const original = 'sidecar sentinel\n';
  for (const suffix of ['-wal', '-shm', '-journal']) {
    writeFileSync(sentinel, original, { mode: 0o600 });
    const sidecar = `${dbPath}${suffix}`;
    linkSync(sentinel, sidecar);
    assert.throws(() => openDurableDatabase({ path: dbPath, root, trustedBoundary: root }),
      (error) => error?.code === 'hardlink');
    assert.equal(readFileSync(sentinel, 'utf8'), original);
    unlinkSync(sidecar);
  }

  const source = openDurableDatabase({ path: dbPath, root, trustedBoundary: root });
  const destination = join(root, 'backup.db');
  const backupSidecar = `${destination}-shm`;
  writeFileSync(sentinel, original, { mode: 0o600 });
  linkSync(sentinel, backupSidecar);
  await assert.rejects(
    durableBackup(source, destination, { root, trustedBoundary: root }),
    (error) => error?.code === 'hardlink',
  );
  assert.equal(existsSync(destination), false);
  assert.equal(readFileSync(sentinel, 'utf8'), original);
  unlinkSync(backupSidecar);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${destination}${suffix}`;
    writeFileSync(sidecar, original, { mode: 0o600 });
    await assert.rejects(
      durableBackup(source, destination, { root, trustedBoundary: root }),
      (error) => error?.code === 'backup_exists',
    );
    assert.equal(existsSync(destination), false);
    assert.equal(readFileSync(sidecar, 'utf8'), original);
    unlinkSync(sidecar);
  }
  source.close();
});

test('SQLite busy faults preserve competing transaction state and backups restore consistently', async (t) => {
  const root = fixture(t);
  const dbPath = join(root, 'state.db');
  const backupPath = join(root, 'state.backup.db');
  const restoredPath = join(root, 'state.restored.db');
  const first = openDurableDatabase({ path: dbPath, root, trustedBoundary: root, busyTimeoutMs: 100 });
  first.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  first.prepare('INSERT INTO events (value) VALUES (?)').run('before-lock');
  first.exec('BEGIN IMMEDIATE');
  first.prepare('INSERT INTO events (value) VALUES (?)').run('held-by-first');

  const second = openDurableDatabase({ path: dbPath, root, trustedBoundary: root, busyTimeoutMs: 20 });
  assert.throws(() => second.prepare('INSERT INTO events (value) VALUES (?)').run('must-not-write'),
    /busy|locked/i);
  assert.deepEqual(second.prepare('SELECT value FROM events ORDER BY id').all().map((row) => ({ ...row })), [
    { value: 'before-lock' },
  ]);
  second.close();
  first.exec('ROLLBACK');

  transaction(first, (connection) => {
    connection.prepare('INSERT INTO events (value) VALUES (?)').run('after-rollback');
  });
  await durableBackup(first, backupPath, { root, trustedBoundary: root });
  first.close();
  const backedUp = openDurableDatabase({ path: backupPath, root, trustedBoundary: root });
  await durableBackup(backedUp, restoredPath, { root, trustedBoundary: root });
  backedUp.close();
  const restored = openDurableDatabase({ path: restoredPath, root, trustedBoundary: root });
  assert.deepEqual(restored.prepare('SELECT value FROM events ORDER BY id').all().map((row) => ({ ...row })), [
    { value: 'before-lock' }, { value: 'after-rollback' },
  ]);
  restored.close();
});

test('unsupported user_version is refused before a writable open or pragma mutation', (t) => {
  const root = fixture(t);
  const dbPath = join(root, 'versioned.db');
  // Exercise schema rejection independently of the runner's process umask.
  writeFileSync(dbPath, '', { flag: 'wx', mode: 0o600 });
  const raw = new DatabaseSync(dbPath, { allowExtension: false });
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => openDurableDatabase({ path: dbPath, root, trustedBoundary: root, expectedUserVersion: 0 }),
    (error) => error?.code === 'unknown_schema');
  const verify = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false });
  assert.equal(verify.prepare('PRAGMA user_version').get().user_version, 99);
  verify.close();
});

test('unknown schema with crash-left WAL and missing shm is refused before probing', async (t) => {
  const root = fixture(t);
  const dbPath = join(root, 'wal-version.db');
  const initial = openDurableDatabase({ path: dbPath, root, trustedBoundary: root });
  initial.exec('CREATE TABLE events (value TEXT NOT NULL)');
  initial.close();

  const ready = join(root, 'raw-crash.ready');
  const child = spawnChild([
    '--action', 'raw-uncommitted', '--db', dbPath, '--root', root,
    '--value', 'crash-left', '--ready', ready,
  ]);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const childExit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  await waitFor(ready);
  child.kill('SIGKILL');
  const result = await childExit;
  assert.equal(result.signal, 'SIGKILL');

  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  assert.equal(existsSync(walPath), true);
  assert.equal(existsSync(shmPath), true);
  const mainBefore = readFileSync(dbPath);
  const walBefore = readFileSync(walPath);
  unlinkSync(shmPath);
  assert.throws(() => openDurableDatabase({
    path: dbPath, root, trustedBoundary: root, expectedUserVersion: 0,
  }), (error) => error?.code === 'incomplete_artifact');
  assert.equal(existsSync(shmPath), false);
  assert.deepEqual(readFileSync(dbPath), mainBefore);
  assert.deepEqual(readFileSync(walPath), walBefore);
});

test('cleanly closed WAL unknown schema is rejected without creating sidecars', (t) => {
  const root = fixture(t);
  const dbPath = join(root, 'closed-wal-version.db');
  const initial = openDurableDatabase({ path: dbPath, root, trustedBoundary: root });
  initial.close();
  const raw = new DatabaseSync(dbPath, { allowExtension: false });
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA user_version = 99; CREATE TABLE events (value TEXT)');
  raw.close();
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  assert.equal(existsSync(walPath), false);
  assert.equal(existsSync(shmPath), false);
  const mainBefore = readFileSync(dbPath);
  assert.throws(() => openDurableDatabase({
    path: dbPath, root, trustedBoundary: root, expectedUserVersion: 0,
  }), (error) => error?.code === 'unknown_schema');
  assert.equal(existsSync(walPath), false);
  assert.equal(existsSync(shmPath), false);
  assert.deepEqual(readFileSync(dbPath), mainBefore);
});

test('explicit invalid busy timeouts fail before database creation', (t) => {
  const root = fixture(t);
  const dbPath = join(root, 'invalid-timeout.db');
  for (const busyTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 120_001, null]) {
    assert.throws(() => openDurableDatabase({
      path: dbPath, root, trustedBoundary: root, busyTimeoutMs,
    }), (error) => error?.code === 'invalid_timeout');
    assert.equal(existsSync(dbPath), false);
  }
});

test('flock ownership is held for the child lifetime, rejects a competitor, and releases after SIGKILL', async (t) => {
  const root = fixture(t);
  const lockPath = join(root, 'worker.lock');
  const sentinel = join(root, 'sentinel');
  const firstReady = join(root, 'first.ready');
  const first = spawnOwnedProcess({
    lockPath,
    executable: process.execPath,
    args: [CHILD, '--action', 'hold', '--lock-ready', firstReady, '--root', root],
    stdio: 'ignore', trustedBoundary: root,
  });
  t.after(() => { if (first.exitCode === null) first.kill('SIGKILL'); });
  await waitFor(firstReady);

  const competitor = spawnOwnedProcess({
    lockPath,
    executable: process.execPath,
    args: [CHILD, '--action', 'hold', '--lock-ready', sentinel, '--root', root],
    stdio: 'ignore', trustedBoundary: root,
  });
  const result = await ownershipResult(competitor);
  assert.equal(result.code, 1);
  assert.equal(existsSync(sentinel), false, 'failed competitor must not run or remove owned files');

  first.kill('SIGKILL');
  await new Promise((resolve) => first.once('exit', resolve));
  const replacementReady = join(root, 'replacement.ready');
  const replacement = spawnOwnedProcess({
    lockPath,
    executable: process.execPath,
    args: [CHILD, '--action', 'hold', '--lock-ready', replacementReady, '--root', root],
    stdio: 'ignore', trustedBoundary: root,
  });
  t.after(() => { if (replacement.exitCode === null) replacement.kill('SIGKILL'); });
  await waitFor(replacementReady);
  replacement.kill('SIGKILL');
  await new Promise((resolve) => replacement.once('exit', resolve));
});
