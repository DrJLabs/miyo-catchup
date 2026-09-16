import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runNativeHost } from './native-host.mjs';
import { assertSafePath, normalizeAbsolutePath } from './safe-paths.mjs';

const CONFIG_LIMIT = 16 * 1024;
const ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/$/;

// Local installation configuration, not a new wire operation. The generated
// launcher pins this file; Chrome supplies only the caller-origin argument.
export function readNativeHostConfiguration(path, { trustedBoundary } = {}) {
  let fd;
  try {
    assertSafePath(dirname(path), { expectedType: 'directory', privateMode: true, trustedBoundary });
    assertSafePath(path, { expectedType: 'file', privateMode: true, trustedBoundary });
    const before = lstatSync(path);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.uid !== process.getuid() || opened.nlink !== 1
      || (opened.mode & 0o777) !== 0o600 || opened.size < 2 || opened.size > CONFIG_LIMIT) {
      throw new Error();
    }
    // Read at most the cap plus one byte even if the file changes after fstat.
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
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
    if (config === null || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).sort().join(',') !== 'extension_id,socket_path,version'
      || config.version !== 1 || typeof config.extension_id !== 'string'
      || !/^[a-p]{32}$/.test(config.extension_id)
      || typeof config.socket_path !== 'string' || /[\u0000-\u001f\u007f]/.test(config.socket_path)
      || Buffer.byteLength(config.socket_path) > 103 || config.socket_path === '/') throw new Error();
    normalizeAbsolutePath(config.socket_path);
    return Object.freeze(config);
  } catch {
    throw new Error('invalid_host_configuration');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function connectWorker(options) {
  const { connectProbeSocket } = await import('./probe-socket.mjs');
  return connectProbeSocket(options);
}

export async function runNativeHostEntry({ args, input, output,
  readConfiguration = readNativeHostConfiguration, connect = connectWorker,
  runtimeVersion = process.version } = {}) {
  // No home/config/profile/environment defaults, arbitrary extra flags, worker
  // startup, or diagnostic passthrough. Invalid callers cannot open a socket.
  if (runtimeVersion !== 'v22.23.2' || !Array.isArray(args) || args.length !== 2
    || typeof args[0] !== 'string' || typeof args[1] !== 'string' || !ORIGIN.test(args[1])) {
    throw new Error('invalid_host_invocation');
  }
  const configuration = readConfiguration(args[0]);
  return runNativeHost({ input, output, origin: args[1], extensionId: configuration.extension_id,
    connectWorker: () => connect({ socketPath: configuration.socket_path }) });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runNativeHostEntry({ args: process.argv.slice(2), input: process.stdin, output: process.stdout });
  } catch {
    // stdout is exclusively framed protocol traffic. Even local path/runtime
    // errors must not disclose configuration or raw diagnostics in Chrome logs.
    process.stderr.write('miyo-catchup: native host unavailable\n');
    process.exitCode = 1;
  }
}
