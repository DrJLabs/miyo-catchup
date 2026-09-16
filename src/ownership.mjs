import { accessSync, constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { assertSafePath, createPrivateFile, normalizeAbsolutePath } from './safe-paths.mjs';

export const FLOCK_PATH = '/usr/bin/flock';

export class OwnershipError extends Error {
  constructor(message, code = 'ownership_error') {
    super(message);
    this.name = 'OwnershipError';
    this.code = code;
  }
}

function preflightExecutable(executable) {
  if (typeof executable !== 'string' || executable.length === 0 || executable.includes('\0')) {
    throw new OwnershipError('executable must be a non-empty path', 'invalid_executable');
  }
  if (!executable.startsWith('/')) {
    throw new OwnershipError('executable must be absolute', 'invalid_executable');
  }
  try {
    accessSync(executable, fsConstants.X_OK);
  } catch {
    throw new OwnershipError('executable is unavailable', 'invalid_executable');
  }
  return executable;
}

/**
 * Start one process under the installed OS flock implementation. `-F` makes
 * flock exec the command while retaining the descriptor for the command's
 * complete lifetime. Arguments are passed as an argv array; no shell or
 * command-string interpolation is used.
 */
export function spawnOwnedProcess({
  lockPath,
  executable,
  args = [],
  cwd,
  env,
  stdio = 'inherit',
  trustedBoundary,
  detached = false,
} = {}) {
  if (typeof lockPath !== 'string') {
    throw new OwnershipError('lock path must be explicitly injected', 'missing_lock_path');
  }
  const normalizedLock = normalizeAbsolutePath(lockPath, 'lock path');
  assertSafePath(normalizedLock, {
    label: 'lock path',
    expectedType: 'file',
    allowMissingLeaf: true,
    privateMode: false,
    trustedBoundary,
  });
  const command = preflightExecutable(executable);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new OwnershipError('command args must be a NUL-free string array', 'invalid_args');
  }
  if (cwd !== undefined) {
    assertSafePath(cwd, { label: 'working directory', expectedType: 'directory', trustedBoundary });
  }
  if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env))) {
    throw new OwnershipError('environment must be an object', 'invalid_env');
  }
  // All validation completes before creating the lock file. A malformed
  // command must not leave an apparently-owned lock artifact behind.
  createPrivateFile(normalizedLock, { trustedBoundary });
  const child = spawn(FLOCK_PATH, ['-n', '-F', normalizedLock, command, ...args], {
    cwd,
    env,
    stdio,
    shell: false,
    detached,
  });
  return child;
}

export function ownershipResult(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
