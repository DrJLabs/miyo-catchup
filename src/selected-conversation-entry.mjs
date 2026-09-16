import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runConnectionCheckEntry, runConnectionCheckOwner } from './connection-check-entry.mjs';
import { readNativeHostConfiguration } from './native-host-entry.mjs';
import { assertSafePath, normalizeAbsolutePath } from './safe-paths.mjs';

const CONFIG_LIMIT = 16 * 1024;
const ENTRY_PATH = fileURLToPath(import.meta.url);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCOPE = 'background-selected-conversation';

function readPrivateJson(path, { trustedBoundary } = {}) {
  let fd;
  try {
    assertSafePath(dirname(path), {
      label: 'selected configuration directory', expectedType: 'directory',
      privateMode: true, trustedBoundary,
    });
    assertSafePath(path, {
      label: 'selected configuration', expectedType: 'file',
      privateMode: true, trustedBoundary,
    });
    const before = lstatSync(path);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : opened.uid;
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.uid !== uid || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600
      || opened.size < 2 || opened.size > CONFIG_LIMIT) throw new Error();
    const buffer = Buffer.alloc(CONFIG_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== opened.size || length > CONFIG_LIMIT || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || after.nlink !== 1 || (after.mode & 0o777) !== 0o600) throw new Error();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(buffer.subarray(0, length)));
  } catch {
    throw new Error('invalid_selected_configuration');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertIdentifier(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('invalid_selected_configuration');
  return value;
}

/**
 * Read the explicitly selected-body configuration. This is intentionally not
 * an option on setup-inspection-entry: the scope literal, non-null binding
 * context and separate root are all required before a receiver can start.
 */
export function readSelectedConversationConfiguration(path, { trustedBoundary } = {}) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('invalid_selected_configuration');
  const config = readPrivateJson(path, { trustedBoundary });
  if (config === null || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).sort().join(',') !== 'binding,conversation_id,execution_context,native_host_config,root,scope,version'
    || config.version !== 1 || config.scope !== SCOPE
    || config.execution_context !== 'extension-background'
    || typeof config.native_host_config !== 'string' || typeof config.root !== 'string'
    || typeof config.conversation_id !== 'string' || config.binding === null
    || typeof config.binding !== 'object' || Array.isArray(config.binding)
    || Object.keys(config.binding).sort().join(',') !== 'account_id,binding_id,context_id,principal_id'
    || typeof config.binding.context_id !== 'string') {
    throw new Error('invalid_selected_configuration');
  }
  const nativePath = normalizeAbsolutePath(config.native_host_config, 'native host configuration');
  const root = normalizeAbsolutePath(config.root, 'selected conversation root');
  if (root === '/' || nativePath === '/') throw new Error('invalid_selected_configuration');
  assertIdentifier(config.conversation_id);
  for (const key of ['binding_id', 'principal_id', 'account_id', 'context_id']) {
    assertIdentifier(config.binding[key]);
  }
  assertSafePath(root, {
    label: 'selected conversation root', expectedType: 'directory',
    privateMode: true, trustedBoundary,
  });
  const native = readNativeHostConfiguration(nativePath, { trustedBoundary });
  return Object.freeze({
    ...config,
    native_host_config: nativePath,
    root,
    socket_path: native.socket_path,
    extension_id: native.extension_id,
    binding: Object.freeze({ ...config.binding }),
  });
}

export async function runSelectedConversationOwner({
  configPath,
  trustedBoundary,
  lifetimeMs,
  runtimeVersion = process.version,
  readConfiguration = readSelectedConversationConfiguration,
  createReceiver,
  createServer,
} = {}) {
  const receiverFactory = createReceiver ?? (async ({ configuration, ownership }) => {
    const { createProbeReceiver } = await import('./probe-receiver.mjs');
    return createProbeReceiver({
      scope: SCOPE,
      root: configuration.root,
      trustedBoundary,
      binding: configuration.binding,
      conversationId: configuration.conversation_id,
      ownership,
    });
  });
  return runConnectionCheckOwner({
    configPath,
    trustedBoundary,
    lifetimeMs,
    runtimeVersion,
    readConfiguration,
    createReceiver: receiverFactory,
    createServer,
  });
}

export async function runSelectedConversationEntry({
  args,
  runtimeVersion = process.version,
  readConfiguration = readSelectedConversationConfiguration,
  spawn,
  wait,
  entryPath = ENTRY_PATH,
  executable = process.execPath,
  stdio = 'inherit',
} = {}) {
  return runConnectionCheckEntry({
    args,
    runtimeVersion,
    readConfiguration,
    spawn,
    wait,
    entryPath,
    executable,
    stdio,
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === '--owned' && argv.length === 2) {
      const result = await runSelectedConversationOwner({ configPath: argv[1] });
      if (result.reason === 'socket_ownership_lost') process.exit(1);
    } else {
      const result = await runSelectedConversationEntry({ args: argv });
      process.exitCode = result?.code ?? 1;
    }
  } catch {
    process.stderr.write('miyo-catchup: selected conversation unavailable\n');
    process.exitCode = 1;
  }
}
