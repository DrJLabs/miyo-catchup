import {
  chmodSync,
  lstatSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import net from 'node:net';

import {
  assertReply,
  assertRequest,
} from './contracts.mjs';
import {
  encodeNativeMessage,
  FrameError,
  NativeFrameDecoder,
  MAX_MESSAGE_BYTES,
} from './framing.mjs';
import { assertSafePath, normalizeAbsolutePath } from './safe-paths.mjs';

export const SOCKET_CONNECT_TIMEOUT_MS = 5_000;
export const SOCKET_REQUEST_TIMEOUT_MS = 30_000;
export const SOCKET_IDLE_TIMEOUT_MS = 30_000;

const SOCKET_MODE = 0o600;
// Native framing adds a four-byte length prefix to the bounded JSON body.
const MAX_PENDING_BYTES = MAX_MESSAGE_BYTES + 4;
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

export class ProbeSocketError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProbeSocketError';
    this.code = code;
  }
}

function currentUid() {
  if (typeof process.getuid !== 'function') throw new ProbeSocketError('uid_unavailable');
  return process.getuid();
}

function ownershipResult(value) {
  return value === true;
}

async function requireOwnership(ownership) {
  if (typeof ownership !== 'function') throw new ProbeSocketError('ownership_required');
  let result;
  try { result = await ownership(); } catch { throw new ProbeSocketError('ownership_not_held'); }
  if (!ownershipResult(result)) throw new ProbeSocketError('ownership_not_held');
}

function statIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function statSocket(pathname, ownerUid) {
  let stat;
  try { stat = lstatSync(pathname); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ProbeSocketError('socket_stat_failed');
  }
  if (stat.isSymbolicLink()) throw new ProbeSocketError('socket_symlink');
  if (!stat.isSocket()) throw new ProbeSocketError('socket_wrong_type');
  if (stat.uid !== ownerUid) throw new ProbeSocketError('socket_wrong_owner');
  if (stat.nlink !== 1) throw new ProbeSocketError('socket_hardlink');
  if ((stat.mode & 0o7777) !== SOCKET_MODE) throw new ProbeSocketError('socket_unsafe_mode');
  return stat;
}

function validatePrivatePaths({ socketPath, privateRoot, trustedBoundary }) {
  if (typeof privateRoot !== 'string' || typeof socketPath !== 'string') {
    throw new ProbeSocketError('paths_required');
  }
  if (/[\u0000-\u001f\u007f]/u.test(socketPath)
    || Buffer.byteLength(socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new ProbeSocketError('unsafe_path');
  }
  let root;
  let socket;
  try {
    root = normalizeAbsolutePath(privateRoot, 'privateRoot');
    socket = normalizeAbsolutePath(socketPath, 'socketPath');
  } catch { throw new ProbeSocketError('unsafe_path'); }
  const rel = relative(root, socket);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel === '') {
    throw new ProbeSocketError('unsafe_path');
  }
  const ownerUid = currentUid();
  try {
    assertSafePath(root, {
      label: 'privateRoot',
      expectedType: 'directory',
      privateMode: true,
      trustedBoundary,
    });
    assertSafePath(dirname(socket), {
      label: 'socket parent',
      expectedType: 'directory',
      privateMode: true,
      trustedBoundary,
    });
  } catch { throw new ProbeSocketError('unsafe_path'); }
  return Object.freeze({ root, socket, ownerUid });
}

function verifySocketIdentity(pathname, expected, ownerUid) {
  const current = statSocket(pathname, ownerUid);
  if (!current || statIdentity(current) !== expected) throw new ProbeSocketError('socket_ownership_lost');
  return current;
}

function unlinkOwnedSocket(pathname, stat, ownerUid) {
  if (!stat) throw new ProbeSocketError('socket_not_owned');
  const current = statSocket(pathname, ownerUid);
  if (!current || statIdentity(current) !== statIdentity(stat)) {
    throw new ProbeSocketError('socket_replaced');
  }
  try { unlinkSync(pathname); } catch { throw new ProbeSocketError('socket_cleanup_failed'); }
  try {
    if (lstatSync(pathname)) throw new ProbeSocketError('socket_cleanup_failed');
  } catch (error) {
    if (error instanceof ProbeSocketError) throw error;
    if (error?.code !== 'ENOENT') throw new ProbeSocketError('socket_cleanup_failed');
  }
}

function attachSocketErrorGuard(socket, onFailure) {
  const onError = () => onFailure('connection_lost');
  const onClose = () => onFailure('connection_lost');
  socket.on('error', onError);
  socket.on('close', onClose);
  return () => {
    socket.removeListener('error', onError);
    socket.removeListener('close', onClose);
  };
}

function withTimeout(operation, timeoutMs, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout(); } catch { /* timeout cleanup is best effort */ }
      reject(new ProbeSocketError('timeout'));
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
}

function writeFrame(socket, frame) {
  if (socket.destroyed || socket.writableEnded) return Promise.reject(new ProbeSocketError('connection_lost'));
  if (frame.length > MAX_PENDING_BYTES) return Promise.reject(new ProbeSocketError('frame_too_large'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let writeDone = false;
    let drainDone = false;
    const cleanup = () => {
      socket.removeListener('drain', onDrain);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const done = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const maybeDone = () => {
      if (writeDone && drainDone) done();
    };
    const onDrain = () => { drainDone = true; maybeDone(); };
    const onError = () => done(new ProbeSocketError('connection_lost'));
    const onClose = () => done(new ProbeSocketError('connection_lost'));
    socket.once('error', onError);
    socket.once('close', onClose);
    let accepted;
    try {
      accepted = socket.write(frame, (error) => {
        if (error) { done(new ProbeSocketError('connection_lost')); return; }
        writeDone = true;
        maybeDone();
      });
    } catch { done(new ProbeSocketError('connection_lost')); return; }
    if (accepted === false) {
      socket.once('drain', onDrain);
    } else {
      drainDone = true;
      maybeDone();
    }
  });
}

function connectSocket(pathname, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: pathname });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      callback(value);
    };
    const onConnect = () => finish(resolve, socket);
    const onError = () => finish(reject, new ProbeSocketError('connect_failed'));
    const onClose = () => {
      if (!settled) finish(reject, new ProbeSocketError('connection_lost'));
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(reject, new ProbeSocketError('timeout'));
    }, timeoutMs);
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function pumpClient(socket, state, requestTimeoutMs) {
  const decoder = new NativeFrameDecoder((value) => {
    if (!state.pending) throw new FrameError('unexpected_reply');
    assertReply(value, state.pending.request.operation);
  });
  try {
    for await (const chunk of socket) {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
        throw new ProbeSocketError('invalid_socket_chunk');
      }
      await decoder.consume(Buffer.from(chunk), (reply) => {
        const pending = state.pending;
        if (!pending || reply.request_id !== pending.request.request_id) {
          throw new FrameError('reply_mismatch');
        }
        state.pending = null;
        pending.resolve(reply);
      });
    }
    decoder.finish();
    if (!state.closed) state.fail('connection_lost');
  } catch {
    if (!state.closed) state.fail('connection_lost');
  }
  // Keep the parameter in the function signature as an explicit reminder
  // that every pending request is bounded by its own timer.
  void requestTimeoutMs;
}

/**
 * Connect to a caller-selected private worker socket. The returned object is
 * directly usable as runNativeHost({ connectWorker: () => connector }).
 * There is no default path, reconnect, queue, or fallback transport.
 */
export async function connectProbeSocket({
  socketPath,
  privateRoot = typeof socketPath === 'string' ? dirname(socketPath) : undefined,
  trustedBoundary,
  connectTimeoutMs = SOCKET_CONNECT_TIMEOUT_MS,
  requestTimeoutMs = SOCKET_REQUEST_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1
    || connectTimeoutMs > SOCKET_CONNECT_TIMEOUT_MS
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1
    || requestTimeoutMs > SOCKET_REQUEST_TIMEOUT_MS) {
    throw new ProbeSocketError('invalid_timeout');
  }
  const paths = validatePrivatePaths({ socketPath, privateRoot, trustedBoundary });
  const existing = statSocket(paths.socket, paths.ownerUid);
  if (existing === null) throw new ProbeSocketError('socket_missing');
  const socket = await connectSocket(paths.socket, connectTimeoutMs);
  const state = {
    closed: false,
    pending: null,
    fail: (code) => {
      if (state.closed) return;
      state.closed = true;
      const pending = state.pending;
      state.pending = null;
      if (pending) pending.reject(new ProbeSocketError(code));
      socket.destroy();
    },
  };
  const removeGuard = attachSocketErrorGuard(socket, state.fail);
  void pumpClient(socket, state, requestTimeoutMs);
  const connector = {
    async request(request) {
      if (state.closed) throw new ProbeSocketError('connection_closed');
      if (state.pending) throw new ProbeSocketError('busy');
      try { assertRequest(request); } catch { state.fail('protocol_failed'); throw new ProbeSocketError('protocol_failed'); }
      let frame;
      try { frame = encodeNativeMessage(request, assertRequest); }
      catch { state.fail('protocol_failed'); throw new ProbeSocketError('protocol_failed'); }
      const result = new Promise((resolve, reject) => { state.pending = { request, resolve, reject }; });
      // A port loss can reject the pending result while the write promise is
      // still unwinding. Attach a handler before any await to keep that late
      // rejection observed without retaining an unbounded queue.
      result.catch(() => {});
      try {
        await withTimeout(() => writeFrame(socket, frame), requestTimeoutMs, () => state.fail('timeout'));
        return await withTimeout(() => result, requestTimeoutMs, () => state.fail('timeout'));
      } catch (error) {
        if (state.pending?.request === request) {
          const pending = state.pending;
          state.pending = null;
          pending.reject(error instanceof ProbeSocketError ? error : new ProbeSocketError('connection_lost'));
        }
        state.fail(error instanceof ProbeSocketError ? error.code : 'connection_lost');
        throw error instanceof ProbeSocketError ? error : new ProbeSocketError('connection_lost');
      }
    },
    async close() {
      if (state.closed) return;
      state.closed = true;
      const pending = state.pending;
      state.pending = null;
      if (pending) pending.reject(new ProbeSocketError('connection_closed'));
      const cleanupOnClose = () => {
        socket.removeListener('close', cleanupOnClose);
        removeGuard();
      };
      socket.once('close', cleanupOnClose);
      socket.destroy();
      if (socket.destroyed && socket.readyState === 'closed') cleanupOnClose();
    },
  };
  return Object.freeze(connector);
}

async function serveConnection(socket, receiver, state, requestTimeoutMs, idleTimeoutMs, ownership) {
  const decoder = new NativeFrameDecoder(assertRequest);
  let pendingAbort;
  const cancelPending = () => {
    if (!pendingAbort) return;
    // Local receiver cancellation is cooperative. Never admit another client
    // after uncertain asynchronous work, even if a receiver ignores its signal.
    state.serverFailed = true;
    pendingAbort.abort();
  };
  socket.on('close', cancelPending);
  const fail = (code) => {
    if (state.failure) return;
    state.failure = new ProbeSocketError(code);
    cancelPending();
    socket.destroy();
  };
  state.failure = null;
  socket.setTimeout(idleTimeoutMs, () => fail('timeout'));
  try {
    await requireOwnership(ownership);
    for await (const chunk of socket) {
      if (state.failure) throw state.failure;
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
        throw new ProbeSocketError('invalid_socket_chunk');
      }
      await decoder.consume(Buffer.from(chunk), async (request) => {
        await requireOwnership(ownership);
        let reply;
        const abort = new AbortController();
        pendingAbort = abort;
        try {
          reply = await withTimeout(() => receiver.request(request, { signal: abort.signal }),
            requestTimeoutMs, () => fail('timeout'));
          if (abort.signal.aborted) throw new ProbeSocketError('receiver_cancelled');
        } catch (error) {
          if (state.failure) throw state.failure;
          throw error instanceof ProbeSocketError ? error : new ProbeSocketError('receiver_failed');
        } finally {
          pendingAbort = null;
        }
        let validated;
        try { validated = assertReply(reply, request.operation); } catch { throw new ProbeSocketError('invalid_reply'); }
        if (validated.request_id !== request.request_id) throw new ProbeSocketError('reply_mismatch');
        let frame;
        try { frame = encodeNativeMessage(validated, (value) => assertReply(value, request.operation)); }
        catch { throw new ProbeSocketError('invalid_reply'); }
        await withTimeout(() => writeFrame(socket, frame), requestTimeoutMs, () => fail('timeout'));
      });
    }
    decoder.finish();
  } catch {
    fail(state.failure?.code ?? 'connection_lost');
  } finally {
    socket.removeListener('close', cancelPending);
  }
}

/**
 * Start one explicit private Unix socket around an injected receiver. The
 * receiver owns all durable state; this transport only validates, frames and
 * serializes requests. A caller-held process lock is mandatory.
 * receiver.request(request, { signal }) must be bounded: synchronous (the T02
 * SQLite receiver) or cooperatively abortable, with no new effects after abort.
 * A timeout is NOT proof of rollback or cancellation. It fences this listener
 * until the owner is stopped/reconciled; no new client is admitted afterward.
 */
export async function createProbeSocketServer({
  socketPath,
  privateRoot,
  trustedBoundary,
  ownership,
  receiver,
  requestTimeoutMs = SOCKET_REQUEST_TIMEOUT_MS,
  idleTimeoutMs = SOCKET_IDLE_TIMEOUT_MS,
} = {}) {
  if (!receiver || typeof receiver.request !== 'function') throw new ProbeSocketError('receiver_required');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1
    || requestTimeoutMs > SOCKET_REQUEST_TIMEOUT_MS
    || !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1
    || idleTimeoutMs > SOCKET_IDLE_TIMEOUT_MS) throw new ProbeSocketError('invalid_timeout');
  const paths = validatePrivatePaths({ socketPath, privateRoot, trustedBoundary });
  await requireOwnership(ownership);

  const existing = statSocket(paths.socket, paths.ownerUid);
  if (existing !== null) {
    // Stale cleanup is intentionally possible only after the caller has
    // positively asserted process ownership and the inode is rechecked.
    await requireOwnership(ownership);
    unlinkOwnedSocket(paths.socket, existing, paths.ownerUid);
  } else {
    try {
      if (lstatSync(paths.socket)) throw new ProbeSocketError('socket_path_exists');
    } catch (error) {
      if (error instanceof ProbeSocketError) throw error;
      if (error?.code !== 'ENOENT') throw new ProbeSocketError('socket_stat_failed');
    }
  }

  const state = { closed: false, active: null, ownedIdentity: null, serverFailed: false };
  const server = net.createServer((socket) => {
    if (state.closed || state.serverFailed || state.active) {
      socket.destroy();
      return;
    }
    state.active = socket;
    void serveConnection(socket, receiver, state, requestTimeoutMs, idleTimeoutMs, ownership)
      .finally(() => {
        if (state.active === socket) state.active = null;
      });
  });
  server.maxConnections = 1;
  let listening = false;
  let startupReject;
  const onServerError = () => {
    if (!listening) {
      startupReject?.(new ProbeSocketError('listen_failed'));
      return;
    }
    state.serverFailed = true;
    if (state.active) state.active.destroy();
  };
  server.on('error', onServerError);
  try {
    await new Promise((resolve, reject) => {
      startupReject = reject;
      server.listen(paths.socket, () => {
        listening = true;
        startupReject = null;
        resolve();
      });
    });
    // Node creates a Unix socket with the process umask, so enforce the
    // private mode before exposing the handle to a client.
    chmodSync(paths.socket, SOCKET_MODE);
    const bound = statSocket(paths.socket, paths.ownerUid);
    if (!bound) throw new ProbeSocketError('socket_missing');
    state.ownedIdentity = statIdentity(bound);
  } catch (error) {
    server.removeListener('error', onServerError);
    try { server.close(); } catch { /* best effort */ }
    if (error instanceof ProbeSocketError) throw error;
    throw new ProbeSocketError('listen_failed');
  }

  return Object.freeze({
    socketPath: paths.socket,
    async close() {
      if (state.closed) return;
      await requireOwnership(ownership);
      // net.Server.close() asks libuv to unlink the pathname. Verify the
      // pathname immediately before that operation; if another inode replaced
      // it, leave the listener open rather than allowing Node to delete a
      // path this instance no longer owns.
      try { verifySocketIdentity(paths.socket, state.ownedIdentity, paths.ownerUid); }
      catch { throw new ProbeSocketError('socket_ownership_lost'); }
      state.closed = true;
      if (state.active) state.active.destroy();
      await new Promise((resolve) => {
        if (!server.listening) { resolve(); return; }
        server.close(() => resolve());
      });
      server.removeListener('error', onServerError);
    },
  });
}

export const listenProbeSocket = createProbeSocketServer;
