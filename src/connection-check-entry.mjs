import {
  fstatSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createConnectionCheckReceiver } from './connection-check.mjs';
import { readNativeHostConfiguration } from './native-host-entry.mjs';
import { ownershipResult, spawnOwnedProcess } from './ownership.mjs';
import { createProbeSocketServer } from './probe-socket.mjs';
import { assertSafePath, normalizeAbsolutePath } from './safe-paths.mjs';

export const CONNECTION_CHECK_LIFETIME_MS = 10 * 60 * 1000;
const MAX_LIFETIME_MS = CONNECTION_CHECK_LIFETIME_MS;
const MIN_LIFETIME_MS = 1_000;
const OWNED_FLAG = '--owned';
const ENTRY_PATH = fileURLToPath(import.meta.url);

function lockPathFor(socketPath) {
  const normalized = normalizeAbsolutePath(socketPath, 'socket path');
  return join(dirname(normalized), 'connection-check.lock');
}

function assertFlockOwnership(lockPath) {
  const normalized = normalizeAbsolutePath(lockPath, 'lock path');
  let lockStat;
  try {
    lockStat = lstatSync(normalized);
  } catch {
    throw new Error('ownership_unproven');
  }
  if (!lockStat.isFile() || lockStat.nlink !== 1 || (lockStat.mode & 0o777) !== 0o600) {
    throw new Error('ownership_unproven');
  }

  let inherited = false;
  try {
    for (const name of readdirSync('/proc/self/fd')) {
      let target;
      try { target = readlinkSync(`/proc/self/fd/${name}`); } catch { continue; }
      if (target !== normalized) continue;
      try {
        const descriptor = Number(name);
        if (Number.isSafeInteger(descriptor)) {
          const opened = fstatSync(descriptor);
          if (opened.dev === lockStat.dev && opened.ino === lockStat.ino) {
            const info = readFileSync(`/proc/self/fdinfo/${descriptor}`, 'utf8');
            inherited = new RegExp(`^lock:\\s+\\d+:\\s+FLOCK\\s+ADVISORY\\s+WRITE\\s+${process.pid}\\s`, 'm').test(info);
          }
        }
      } catch { /* descriptor may close while enumerating */ }
      if (inherited) break;
    }
  } catch {
    throw new Error('ownership_unproven');
  }
  if (!inherited) throw new Error('ownership_unproven');

  // fdinfo is kernel-reported evidence for this exact inherited descriptor;
  // pathname access alone is never treated as ownership.
  return true;
}

function childEnvironment() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

function validateLifetime(lifetimeMs) {
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < MIN_LIFETIME_MS || lifetimeMs > MAX_LIFETIME_MS) {
    throw new Error('invalid_lifetime');
  }
  return lifetimeMs;
}

/**
 * Run the actual socket owner. This entry is only valid from a process
 * launched by spawnOwnedProcess/flock. `trustedBoundary` is intentionally a
 * test-only injection; the CLI never accepts or forwards it.
 */
export async function runConnectionCheckOwner({
  configPath,
  trustedBoundary,
  lifetimeMs = CONNECTION_CHECK_LIFETIME_MS,
  runtimeVersion = process.version,
  readConfiguration = readNativeHostConfiguration,
  createReceiver = createConnectionCheckReceiver,
  createServer = createProbeSocketServer,
} = {}) {
  if (runtimeVersion !== 'v22.23.2' || typeof configPath !== 'string') {
    throw new Error('invalid_connection_check_invocation');
  }
  validateLifetime(lifetimeMs);
  const configuration = readConfiguration(configPath, { trustedBoundary });
  const socketPath = normalizeAbsolutePath(configuration.socket_path, 'socket path');
  const privateRoot = dirname(socketPath);
  const lockPath = lockPathFor(socketPath);
  assertSafePath(lockPath, { label: 'connection-check lock', expectedType: 'file', privateMode: true, trustedBoundary });
  assertFlockOwnership(lockPath);

  const ownership = () => assertFlockOwnership(lockPath);
  const receiver = await createReceiver({ ownership, configuration });
  let server;
  try {
    server = await createServer({
      socketPath,
      privateRoot,
      trustedBoundary,
      ownership,
      receiver,
    });
  } catch (error) {
    try { receiver.close?.(); } catch { /* receiver cleanup is best effort */ }
    throw error;
  }

  let settled = false;
  let finish;
  const completed = new Promise((resolveCompletion) => { finish = resolveCompletion; });
  const shutdown = async (reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    let outcome = reason;
    try {
      await server.close();
    } catch {
      outcome = 'socket_ownership_lost';
    } finally {
      try { receiver.close?.(); } catch { /* receiver cleanup is best effort */ }
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    finish(outcome);
  };
  const onSignal = () => { void shutdown('signal'); };
  // A terminal signal may reach both launcher and child, then be forwarded.
  // Keep handlers installed until cleanup ends so the duplicate cannot abort it.
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const timer = setTimeout(() => { void shutdown('lifetime'); }, lifetimeMs);
  timer.unref?.();
  const reason = await completed;
  return Object.freeze({ reason });
}

/**
 * Public foreground launcher. It validates only the explicit native-host
 * configuration path, then re-execs this module under a real process-lifetime
 * flock. No defaults, environment overrides, or alternate path flags exist.
 */
export async function runConnectionCheckEntry({
  args,
  runtimeVersion = process.version,
  readConfiguration = readNativeHostConfiguration,
  spawn = spawnOwnedProcess,
  wait = ownershipResult,
  entryPath = ENTRY_PATH,
  executable = process.execPath,
  stdio = 'inherit',
} = {}) {
  if (runtimeVersion !== 'v22.23.2' || !Array.isArray(args) || args.length !== 1
    || typeof args[0] !== 'string' || args[0].length === 0) {
    throw new Error('invalid_connection_check_invocation');
  }
  const configPath = args[0];
  const configuration = readConfiguration(configPath);
  const lockPath = lockPathFor(configuration.socket_path);
  const child = spawn({
    lockPath,
    executable,
    args: [entryPath, OWNED_FLAG, configPath],
    env: childEnvironment(),
    stdio,
  });
  let signalForwarded = false;
  const forwardSignal = (signal) => {
    if (signalForwarded) return;
    signalForwarded = true;
    try { child.kill(signal); } catch { /* child may have exited */ }
  };
  const onSigint = () => forwardSignal('SIGINT');
  const onSigterm = () => forwardSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    return await wait(child);
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === OWNED_FLAG && argv.length === 2) {
      const result = await runConnectionCheckOwner({ configPath: argv[1] });
      // The injectable owner API returns this reason for callers that need to
      // inspect it. The production child must terminate if close refused to
      // touch a replaced/unowned socket; leaving the server handle alive would
      // otherwise defeat the bounded foreground lifetime.
      if (result.reason === 'socket_ownership_lost') process.exit(1);
    } else {
      const result = await runConnectionCheckEntry({ args: argv });
      process.exitCode = result?.code ?? 1;
    }
  } catch {
    process.stderr.write('miyo-catchup: connection check unavailable\n');
    process.exitCode = 1;
  }
}
