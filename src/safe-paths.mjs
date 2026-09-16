import {
  chmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  constants as fsConstants,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

/** A path failed the local trust and ownership checks. */
export class UnsafePathError extends Error {
  constructor(message, code = 'unsafe_path') {
    super(message);
    this.name = 'UnsafePathError';
    this.code = code;
  }
}

function uid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * Normalize an absolute path without resolving symlinks. Symlink resolution is
 * deliberately performed by the component checks below so a caller cannot
 * hide an unsafe ancestor behind a lexical path operation.
 */
export function normalizeAbsolutePath(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new UnsafePathError(`${label} must be a non-empty absolute path`, 'invalid_path');
  }
  if (value.includes('\0')) {
    throw new UnsafePathError(`${label} contains a NUL byte`, 'invalid_path');
  }
  if (!isAbsolute(value)) {
    throw new UnsafePathError(`${label} must be absolute`, 'invalid_path');
  }
  // Reject lexical traversal and redundant separators instead of silently
  // normalizing them away. This keeps containment checks tied to the exact
  // path the caller supplied and avoids hiding a symlinked component.
  if (value !== sep && value.endsWith(sep)) {
    throw new UnsafePathError(`${label} has a redundant trailing separator`, 'invalid_path');
  }
  const parts = value.split(sep).slice(1);
  if (value.includes(`${sep}${sep}`) || parts.some((part) => part === '.' || part === '..')) {
    throw new UnsafePathError(`${label} contains traversal or redundant separators`, 'invalid_path');
  }
  return normalize(value);
}

function modeFor(stat) {
  return stat.mode & 0o777;
}

function checkStat(candidate, stat, { ownerUid, expectedType, privateMode, label, ancestor = false }) {
  // System-owned, non-writable ancestors such as / and /home are safe
  // containers. The leaf and explicit trust boundary must belong to the
  // installing user; a foreign-owned leaf is never adopted.
  if (stat.uid !== ownerUid && !(ancestor && stat.uid === 0)) {
    throw new UnsafePathError(`${label} owner is not the current user`, 'wrong_owner');
  }
  if (stat.isSymbolicLink()) {
    throw new UnsafePathError(`${label} is a symbolic link`, 'symlink');
  }
  if (stat.isDirectory()) {
    if (expectedType === 'file') {
      throw new UnsafePathError(`${label} is not a regular file`, 'wrong_type');
    }
    if (privateMode && modeFor(stat) !== 0o700) {
      throw new UnsafePathError(`${label} directory mode is not 0700`, 'unsafe_mode');
    }
    if ((modeFor(stat) & 0o022) !== 0) {
      throw new UnsafePathError(`${label} directory is group/other writable`, 'unsafe_mode');
    }
    return;
  }
  if (!stat.isFile()) {
    throw new UnsafePathError(`${label} is not a regular file`, 'wrong_type');
  }
  if (stat.nlink !== 1) {
    throw new UnsafePathError(`${label} has multiple hard links`, 'hardlink');
  }
  if (expectedType === 'directory') {
    throw new UnsafePathError(`${label} is not a directory`, 'wrong_type');
  }
  if (privateMode && modeFor(stat) !== 0o600) {
    throw new UnsafePathError(`${label} file mode is not 0600`, 'unsafe_mode');
  }
  if ((modeFor(stat) & 0o022) !== 0) {
    throw new UnsafePathError(`${label} file is group/other writable`, 'unsafe_mode');
  }
}

function statOrMissing(pathname) {
  try {
    return { stat: lstatSync(pathname), missing: false };
  } catch (error) {
    if (error?.code === 'ENOENT') return { stat: null, missing: true };
    throw error;
  }
}

/**
 * Validate every existing component of an absolute path.
 *
 * `trustedBoundary` is an explicit, caller-selected test or installation
 * boundary. The boundary itself is still checked, but ancestors above it are
 * not traversed. Production callers should omit it so `/tmp` and other
 * unsafe ancestors are rejected. Tests use an isolated 0700 temporary
 * directory as their trust boundary.
 */
export function assertSafePath(value, {
  label = 'path',
  expectedType = 'any',
  allowMissingLeaf = false,
  privateMode = false,
  trustedBoundary = undefined,
  ownerUid = uid(),
} = {}) {
  const pathname = normalizeAbsolutePath(value, label);
  const boundary = trustedBoundary === undefined
    ? sep
    : normalizeAbsolutePath(trustedBoundary, 'trustedBoundary');
  const relToBoundary = relative(boundary, pathname);
  if (relToBoundary.startsWith(`..${sep}`) || relToBoundary === '..' || isAbsolute(relToBoundary)) {
    throw new UnsafePathError(`${label} escapes the trusted boundary`, 'outside_boundary');
  }

  const components = [];
  let cursor = pathname;
  while (true) {
    components.push(cursor);
    if (cursor === boundary || cursor === sep) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  // Walk from the boundary down, so a missing parent cannot mask a symlink or
  // mode problem in a later component.
  components.reverse();
  let firstMissing = -1;
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    const { stat, missing } = statOrMissing(component);
    if (missing) {
      if (firstMissing < 0) firstMissing = index;
      continue;
    }
    if (firstMissing >= 0) {
      throw new UnsafePathError(`${label} has a missing parent component`, 'missing_parent');
    }
    const isLeaf = index === components.length - 1;
    checkStat(component, stat, {
      ownerUid,
      expectedType: isLeaf ? expectedType : 'directory',
      // A private leaf and an explicit trust boundary must be owner-only.
      // Ordinary ancestors (for example /home and /home/user) need only be
      // non-writable by group/other; forcing 0700 on them would reject safe
      // installations beneath a conventional 0755 parent.
      privateMode: isLeaf ? privateMode : (component === boundary && boundary !== sep),
      ancestor: !isLeaf,
      label: component === pathname ? label : `${label} ancestor`,
    });
  }
  if (firstMissing >= 0) {
    const missingCount = components.length - firstMissing;
    if (!allowMissingLeaf || missingCount !== 1) {
      throw new UnsafePathError(`${label} has a missing parent or does not exist`, 'missing_path');
    }
    // The parent was checked above; the missing leaf may be safely created by
    // an exclusive O_CREAT|O_NOFOLLOW operation owned by this process.
  }
  return pathname;
}

export function assertContainedPath(value, root, options = {}) {
  const normalizedRoot = normalizeAbsolutePath(root, 'root');
  const pathname = normalizeAbsolutePath(value, options.label ?? 'path');
  const rel = relative(normalizedRoot, pathname);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UnsafePathError('path is outside root', 'outside_root');
  }
  // `root` is a containment constraint, not an implicit trust boundary. A
  // production caller must still have every ancestor (including /tmp) checked;
  // tests may opt into a documented `trustedBoundary` explicitly.
  return assertSafePath(pathname, { ...options, trustedBoundary: options.trustedBoundary });
}

export function ensurePrivateDirectory(pathname, { trustedBoundary, mode = 0o700 } = {}) {
  if (mode !== 0o700) {
    throw new UnsafePathError('private directory mode must be 0700', 'invalid_mode');
  }
  const normalized = normalizeAbsolutePath(pathname, 'directory');
  let present = true;
  try {
    lstatSync(normalized);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    present = false;
  }
  if (present) {
    // Existing directories are never repaired in place. A caller must prove
    // the current mode is already private before this helper returns.
    assertSafePath(normalized, { expectedType: 'directory', privateMode: true, trustedBoundary });
    return normalized;
  }
  assertSafePath(normalized, {
    expectedType: 'directory',
    allowMissingLeaf: true,
    trustedBoundary,
  });
  let created = false;
  try {
    mkdirSync(normalized, { mode });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (!created) {
    assertSafePath(normalized, { expectedType: 'directory', privateMode: true, trustedBoundary });
    return normalized;
  }
  // Only the directory created by this call may be chmod-ed to compensate for
  // the process umask; a pre-existing directory is never silently changed.
  chmodSync(normalized, mode);
  assertSafePath(normalized, { expectedType: 'directory', privateMode: true, trustedBoundary });
  return normalized;
}

export function createPrivateFile(pathname, { trustedBoundary, mode = 0o600 } = {}) {
  if (mode !== 0o600) {
    throw new UnsafePathError('private file mode must be 0600', 'invalid_mode');
  }
  const normalized = normalizeAbsolutePath(pathname, 'file');
  assertSafePath(normalized, {
    expectedType: 'file',
    allowMissingLeaf: true,
    trustedBoundary,
  });
  let descriptor;
  try {
    descriptor = openSync(normalized, fsConstants.O_RDWR | fsConstants.O_CREAT |
      fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), mode);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    assertSafePath(normalized, { expectedType: 'file', privateMode: true, trustedBoundary });
    return false;
  }
  try {
    chmodSync(normalized, mode);
  } finally {
    closeSync(descriptor);
  }
  assertSafePath(normalized, { expectedType: 'file', privateMode: true, trustedBoundary });
  return true;
}

export const validatePath = assertSafePath;
