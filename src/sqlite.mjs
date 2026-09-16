import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  constants as fsConstants,
} from 'node:fs';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import {
  assertContainedPath,
  assertSafePath,
  createPrivateFile,
  normalizeAbsolutePath,
} from './safe-paths.mjs';

export class SQLiteSafetyError extends Error {
  constructor(message, code = 'sqlite_safety') {
    super(message);
    this.name = 'SQLiteSafetyError';
    this.code = code;
  }
}

export const DURABLE_PRAGMAS = Object.freeze({
  journalMode: 'wal',
  synchronous: 2,
  foreignKeys: 1,
  trustedSchema: 0,
});

function requireDatabasePath(options) {
  const value = typeof options === 'string' ? options : options?.path ?? options?.filename;
  if (value === undefined) {
    throw new SQLiteSafetyError('database path must be explicitly injected', 'missing_path');
  }
  return normalizeAbsolutePath(value, 'database path');
}

function pathCheck(pathname, options, { allowMissingLeaf = true, privateMode = true } = {}) {
  const base = options.root ?? options.trustedBoundary;
  const checked = base === undefined
    ? assertSafePath(pathname, {
      label: 'database path',
      expectedType: 'file',
      allowMissingLeaf,
      privateMode,
    })
    : assertContainedPath(pathname, base, {
      label: 'database path',
      expectedType: 'file',
      allowMissingLeaf,
      privateMode,
      trustedBoundary: options.trustedBoundary,
    });
  return checked;
}

const SQLITE_AUXILIARY_SUFFIXES = Object.freeze(['-wal', '-shm', '-journal']);

/**
 * SQLite opens these sibling files by derived pathname. Validate every
 * pre-existing sidecar before even a read-only probe: a symlink or hard link
 * here could otherwise redirect SQLite writes outside the owned namespace.
 */
function validateAuxiliaryFiles(pathname, options, { rejectExisting = false } = {}) {
  const existing = [];
  const present = new Set();
  for (const suffix of SQLITE_AUXILIARY_SUFFIXES) {
    const auxiliary = normalizeAbsolutePath(`${pathname}${suffix}`, 'SQLite auxiliary path');
    try {
      lstatSync(auxiliary);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    pathCheck(auxiliary, options, { allowMissingLeaf: false, privateMode: true });
    existing.push(auxiliary);
    present.add(suffix);
  }
  if (rejectExisting && existing.length > 0) {
    throw new SQLiteSafetyError('backup destination has pre-existing SQLite sidecars', 'backup_exists');
  }
  if (present.has('-wal') && !present.has('-shm')) {
    throw new SQLiteSafetyError('incomplete SQLite WAL sidecar set', 'incomplete_artifact');
  }
  return existing;
}

function ensureDatabaseFile(pathname, options) {
  try {
    pathCheck(pathname, options, { allowMissingLeaf: false, privateMode: true });
    return;
  } catch (error) {
    if (error?.code !== 'missing_path') throw error;
  }
  // The path check above verified every parent. An exclusive no-follow create
  // closes the check/create race and prevents a symlink from being adopted.
  try {
    const descriptor = openSync(pathname, fsConstants.O_RDWR | fsConstants.O_CREAT |
      fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  pathCheck(pathname, options, { allowMissingLeaf: false, privateMode: true });
}

function pragmaValue(db, sql, field) {
  const row = db.prepare(sql).get();
  return row?.[field];
}

function verifyDurability(db) {
  const values = {
    journalMode: String(pragmaValue(db, 'PRAGMA journal_mode', 'journal_mode')).toLowerCase(),
    synchronous: Number(pragmaValue(db, 'PRAGMA synchronous', 'synchronous')),
    foreignKeys: Number(pragmaValue(db, 'PRAGMA foreign_keys', 'foreign_keys')),
    trustedSchema: Number(pragmaValue(db, 'PRAGMA trusted_schema', 'trusted_schema')),
  };
  for (const [key, expected] of Object.entries(DURABLE_PRAGMAS)) {
    if (values[key] !== expected) {
      throw new SQLiteSafetyError(`SQLite durable policy rejected: ${key}`, 'unsafe_policy');
    }
  }
  return values;
}

function readUserVersionHeader(pathname) {
  const header = Buffer.alloc(100);
  let descriptor;
  try {
    descriptor = openSync(pathname, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const bytes = readSync(descriptor, header, 0, header.length, 0);
    // SQLite file format, database header: the fixed header is 100 bytes and
    // user_version is the big-endian 4-byte field at offset 60.
    // https://www.sqlite.org/fileformat.html#the_database_header
    if (bytes < 100 || !header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
      throw new SQLiteSafetyError('SQLite header is unsupported', 'unknown_schema');
    }
    return header.readUInt32BE(60);
  } catch (error) {
    if (error instanceof SQLiteSafetyError) throw error;
    throw new SQLiteSafetyError('SQLite schema version could not be verified', 'unknown_schema');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Open a worker-owned SQLite database with the v2 durable policy. The caller
 * must inject an absolute path (and should inject `root` for tests); no home,
 * XDG or production fallback is ever selected here.
 */
export function openDurableDatabase(options = {}) {
  const pathname = requireDatabasePath(options);
  const normalizedOptions = typeof options === 'string' ? {} : options;
  const suppliedTimeout = normalizedOptions.busyTimeoutMs;
  if (suppliedTimeout !== undefined &&
      (!Number.isSafeInteger(suppliedTimeout) || suppliedTimeout < 0 || suppliedTimeout > 120_000)) {
    throw new SQLiteSafetyError('busy timeout is outside the supported bound', 'invalid_timeout');
  }
  const timeout = suppliedTimeout === undefined ? 1000 : suppliedTimeout;
  const expectedUserVersion = normalizedOptions.expectedUserVersion ?? 0;
  if (!Number.isSafeInteger(expectedUserVersion) || expectedUserVersion < 0) {
    throw new SQLiteSafetyError('expected schema version is invalid', 'invalid_schema_version');
  }
  pathCheck(pathname, normalizedOptions, { allowMissingLeaf: true, privateMode: true });
  let existing = true;
  try {
    lstatSync(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') existing = false;
    else throw error;
  }
  const auxiliaryFiles = validateAuxiliaryFiles(pathname, normalizedOptions);
  if (!existing && auxiliaryFiles.length > 0) {
    throw new SQLiteSafetyError('orphan SQLite auxiliary file', 'orphan_artifact');
  }
  if (existing) {
    // Read the schema marker before opening a writable connection or changing
    // any pragma. An unknown version therefore cannot mutate the database.
    const hasWal = auxiliaryFiles.some((file) => file.endsWith('-wal'));
    if (!hasWal) {
      const actualUserVersion = readUserVersionHeader(pathname);
      if (actualUserVersion !== expectedUserVersion) {
        throw new SQLiteSafetyError('SQLite schema version is unsupported', 'unknown_schema');
      }
    } else {
      // A complete WAL+SHM pair is safe to inspect through SQLite because the
      // preflight above prevents the probe from creating a missing sidecar.
      let probe;
      try {
        probe = new DatabaseSync(pathname, { readOnly: true, timeout, allowExtension: false });
        probe.enableLoadExtension(false);
        const row = probe.prepare('PRAGMA user_version').get();
        const actualUserVersion = Number(row?.user_version);
        if (actualUserVersion !== expectedUserVersion) {
          throw new SQLiteSafetyError('SQLite schema version is unsupported', 'unknown_schema');
        }
      } catch (error) {
        if (error instanceof SQLiteSafetyError) throw error;
        throw new SQLiteSafetyError('SQLite schema version could not be verified', 'unknown_schema');
      } finally {
        try { probe?.close(); } catch { /* preserve the original diagnostic */ }
      }
    }
  }
  ensureDatabaseFile(pathname, normalizedOptions);
  let db;
  try {
    db = new DatabaseSync(pathname, { timeout, allowExtension: false });
    // Explicitly disable loading even if a future Node default changes.
    db.enableLoadExtension(false);
    db.exec(`PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA busy_timeout = ${timeout};`);
    verifyDurability(db);
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* preserve the original diagnostic */ }
    if (error instanceof SQLiteSafetyError) throw error;
    throw new SQLiteSafetyError('SQLite database failed durable-policy setup', 'unsafe_policy');
  }
}

export function transaction(db, callback, { immediate = true } = {}) {
  if (!db || typeof db.exec !== 'function') throw new TypeError('transaction requires DatabaseSync');
  if (typeof callback !== 'function') throw new TypeError('transaction callback must be a function');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  if (callback instanceof AsyncFunction) {
    throw new TypeError('transaction callback must be synchronous');
  }
  db.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = callback(db);
    if (result && typeof result.then === 'function') {
      throw new TypeError('transaction callback must be synchronous');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* a failed transaction is already unusable */ }
    throw error;
  }
}

export async function durableBackup(sourceDb, destination, options = {}) {
  if (!sourceDb || typeof sourceDb.prepare !== 'function') {
    throw new TypeError('sourceDb must be an open DatabaseSync');
  }
  const normalized = normalizeAbsolutePath(destination, 'backup destination');
  const pathOptions = { ...options, root: options.root ?? options.trustedBoundary };
  pathCheck(normalized, pathOptions, { allowMissingLeaf: true, privateMode: false });
  validateAuxiliaryFiles(normalized, pathOptions, { rejectExisting: true });
  // Create missing destinations safely. Existing destinations were verified as
  // owner-only, regular, single-link files by pathCheck.
  if (!createPrivateFile(normalized, { trustedBoundary: pathOptions.trustedBoundary })) {
    throw new SQLiteSafetyError('backup destination already exists', 'backup_exists');
  }
  const pages = await sqliteBackup(sourceDb, normalized, options.backupOptions ?? {});
  // A backup receipt is not returned until both the database file and its
  // containing directory have reached stable storage. Failed backups retain
  // their target for diagnosis; no cleanup can destroy evidence.
  let descriptor;
  try {
    descriptor = openSync(normalized, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  let directory;
  try {
    directory = openSync(dirname(normalized), fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    fsyncSync(directory);
  } finally {
    if (directory !== undefined) closeSync(directory);
  }
  return pages;
}

export function assertDurablePolicy(db) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db must be DatabaseSync');
  return verifyDurability(db);
}
