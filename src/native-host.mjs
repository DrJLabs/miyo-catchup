import { isAbsolute, posix as posixPath } from 'node:path';

import {
  assertReply,
  assertRequest,
} from './contracts.mjs';
import {
  encodeNativeMessage,
  NativeFrameDecoder,
} from './framing.mjs';

export const NATIVE_HOST_NAME = 'local.miyo_chatgpt_catchup';
const EXTENSION_ID = /^[a-p]{32}$/;
const SAFE_ABSOLUTE_PATH = /^(?!.*[\u0000-\u001f\u007f])[\x20-\u007e]+$/;

/**
 * A sanitized error for the native-host boundary.  The host never forwards
 * exception text or remote diagnostics to stdout or the browser.
 */
export class NativeHostError extends Error {
  constructor(code) {
    super(code);
    this.name = 'NativeHostError';
    this.code = code;
  }
}

function validExtensionId(extensionId) {
  return typeof extensionId === 'string' && EXTENSION_ID.test(extensionId);
}

/**
 * Chrome's native messaging origin is an exact allow-list entry.  Do not use
 * URL parsing or prefix checks here: case changes, ports, paths, wildcards and
 * additional origins must all fail closed.
 */
export function validateCallerOrigin(origin, extensionId) {
  return validExtensionId(extensionId)
    && typeof origin === 'string'
    && origin === `chrome-extension://${extensionId}/`;
}

function validateExecutablePath(executablePath) {
  if (typeof executablePath !== 'string' || !SAFE_ABSOLUTE_PATH.test(executablePath)
    || !isAbsolute(executablePath) || executablePath.length > 4096
    || executablePath === '/' || executablePath.endsWith('/')) {
    throw new TypeError('invalid_executable_path');
  }
  // Keep registration deterministic and reject path traversal/dot aliases.
  // This is syntax validation only; registration and executable ownership are
  // a separately authorized installation step.
  if (executablePath !== posixPath.normalize(executablePath)
    || executablePath.split('/').some((part) => part === '..' || part === '.')) {
    throw new TypeError('invalid_executable_path');
  }
  return executablePath;
}

/**
 * Return the exact native-host manifest object without writing or registering
 * anything.  The extension origin is intentionally a singleton exact entry.
 */
export function nativeHostManifest({ extensionId, executablePath } = {}) {
  if (!validExtensionId(extensionId)) throw new TypeError('invalid_extension_id');
  const path = validateExecutablePath(executablePath);
  const origin = `chrome-extension://${extensionId}/`;
  return Object.freeze({
    name: NATIVE_HOST_NAME,
    description: 'Local Miyo ChatGPT catch-up native bridge',
    path,
    type: 'stdio',
    allowed_origins: Object.freeze([origin]),
  });
}

function assertStreams(input, output) {
  if (!input || typeof input[Symbol.asyncIterator] !== 'function'
    || typeof input.on !== 'function' || typeof input.removeListener !== 'function') {
    throw new NativeHostError('invalid_input_stream');
  }
  if (!output || typeof output.write !== 'function'
    || typeof output.on !== 'function' || typeof output.removeListener !== 'function') {
    throw new NativeHostError('invalid_output_stream');
  }
}

function assertConnector(connector) {
  if (!connector || typeof connector.request !== 'function' || typeof connector.close !== 'function') {
    throw new NativeHostError('invalid_worker_connector');
  }
  return connector;
}

async function openConnector(connectWorker) {
  let connector;
  try {
    connector = typeof connectWorker === 'function'
      ? await connectWorker()
      : connectWorker;
  } catch {
    throw new NativeHostError('worker_unavailable');
  }
  return assertConnector(connector);
}

async function closeConnector(connector) {
  if (!connector) return;
  try { await connector.close(); } catch { /* boundary cleanup is best effort */ }
}

class PortCancellation {
  #failure = null;
  #waiters = new Set();

  get failure() { return this.#failure; }

  subscribe(waiter) {
    if (this.#failure) {
      waiter(this.#failure);
      return () => {};
    }
    this.#waiters.add(waiter);
    return () => this.#waiters.delete(waiter);
  }

  fail(error) {
    if (this.#failure) return;
    this.#failure = error;
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) {
      try { waiter(error); } catch { /* cancellation cannot expose callback errors */ }
    }
  }
}

// Await one operation with a removable cancellation subscription.  Promise
// handlers stay attached to the underlying operation after cancellation, so a
// late worker/stream rejection is observed without retaining this frame's
// closure in a shared pending promise.
function awaitWithCancellation(operation, cancellation) {
  if (cancellation.failure) return Promise.reject(cancellation.failure);
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      callback(value);
    };
    unsubscribe = cancellation.subscribe((error) => finish(reject, error));
    if (settled) return;
    let pending;
    try { pending = operation(); }
    catch (error) { finish(reject, error); return; }
    Promise.resolve(pending).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function writeNativeFrame(output, frame, cancellation) {
  if (output.destroyed === true || output.writableEnded === true || output.closed === true) {
    throw new NativeHostError('output_closed');
  }
  if (cancellation.failure) throw cancellation.failure;
  let accepted;
  const writeDone = new Promise((resolve, reject) => {
    try {
      accepted = output.write(frame, (error) => {
        if (error) reject(new NativeHostError('output_failed'));
        else resolve();
      });
    } catch {
      reject(new NativeHostError('output_failed'));
    }
  });
  const drained = accepted === false
    ? new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const cleanup = () => {
        output.removeListener('drain', onDrain);
        output.removeListener('error', onError);
        output.removeListener('close', onClose);
        unsubscribe();
      };
      const onDrain = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new NativeHostError('output_failed')); };
      const onClose = () => { cleanup(); reject(new NativeHostError('output_closed')); };
      const onCancel = (error) => { cleanup(); reject(error); };
      output.once('drain', onDrain);
      output.once('error', onError);
      output.once('close', onClose);
      unsubscribe = cancellation.subscribe(onCancel);
    })
    : Promise.resolve();
  try {
    await awaitWithCancellation(() => Promise.all([writeDone, drained]), cancellation);
  } catch (error) {
    if (error instanceof NativeHostError) throw error;
    if (output.destroyed === true || output.closed === true) throw new NativeHostError('output_closed');
    throw new NativeHostError('output_failed');
  }
  if (output.destroyed === true || output.writableEnded === true || output.closed === true) {
    throw new NativeHostError('output_closed');
  }
}

/**
 * Pump native messages into an injected private worker transport.
 *
 * The input decoder awaits each callback, so there is at most one request and
 * one response in flight.  The worker is deliberately injected: this module
 * owns neither durable state nor a default socket/HTTP fallback.
 */
export async function runNativeHost({
  input,
  output,
  origin,
  extensionId,
  connectWorker,
} = {}) {
  assertStreams(input, output);
  if (!validateCallerOrigin(origin, extensionId)) {
    throw new NativeHostError('unauthorized_origin');
  }

  if (output.destroyed === true || output.writableEnded === true || output.closed === true) {
    throw new NativeHostError('output_closed');
  }

  const cancellation = new PortCancellation();
  let portFailure;
  let inputEnded = false;
  let workerPending = false;
  const failPort = (code) => {
    if (portFailure) return;
    portFailure = new NativeHostError(code);
    cancellation.fail(portFailure);
  };
  const onInputEnd = () => {
    inputEnded = true;
    if (workerPending) failPort('input_closed');
  };
  // Duplex test/bridge streams can signal their writable side has ended while
  // the async iterator is still blocked in a worker callback.  Treat that as
  // input EOF for cancellation purposes; ordinary Readable stdin uses end.
  const onInputFinish = () => {
    inputEnded = true;
    if (workerPending) failPort('input_closed');
  };
  const onInputError = () => failPort('input_failed');
  const onInputClose = () => { if (!inputEnded) failPort('input_closed'); };
  const onOutputError = () => failPort('output_failed');
  const onOutputClose = () => failPort('output_closed');
  input.on('end', onInputEnd);
  input.on('finish', onInputFinish);
  input.on('error', onInputError);
  input.on('close', onInputClose);
  // Keep an error listener for the whole host lifetime.  A Writable may emit
  // an asynchronous error after write() returned true; removing this listener
  // at the first successful write would turn that port failure into an
  // unhandled process-level exception.
  output.on('error', onOutputError);
  output.on('close', onOutputClose);
  // A stream can close between the initial state check and listener
  // installation (especially with a synthetic or already-destroyed port).
  if (input.destroyed === true && !inputEnded) failPort('input_closed');
  if (output.destroyed === true || output.closed === true) failPort('output_closed');
  const cleanupInput = () => {
    input.removeListener('end', onInputEnd);
    input.removeListener('finish', onInputFinish);
    input.removeListener('error', onInputError);
    input.removeListener('close', onInputClose);
  };
  const cleanupOutput = () => {
    // Keep the error/close guards on an open output after a normal input EOF;
    // a later asynchronous write error must still be consumed.  Once the
    // output has closed, both listeners are safe to remove.
    if (output.destroyed === true || output.closed === true) {
      output.removeListener('error', onOutputError);
      output.removeListener('close', onOutputClose);
    }
  };

  let connector;
  let connectorPromise;
  // This is intentionally after origin and stream validation.  An invalid
  // caller cannot cause a worker connection or any worker-side effects.
  connectorPromise = openConnector(connectWorker);
  try {
    connector = await awaitWithCancellation(() => connectorPromise, cancellation);
  } catch (error) {
    // If the connection resolves after a port loss, close that late connector
    // as well; awaitWithCancellation observes both branches.
    connectorPromise.then((late) => closeConnector(late), () => {});
    cleanupInput();
    cleanupOutput();
    throw error instanceof NativeHostError ? error : new NativeHostError('worker_unavailable');
  }
  const decoder = new NativeFrameDecoder(assertRequest);
  let processed = 0;
  const iterator = input[Symbol.asyncIterator]();

  try {
    while (true) {
      const next = await awaitWithCancellation(() => iterator.next(), cancellation);
      if (next.done) break;
      const chunk = next.value;
      if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
        throw new NativeHostError('invalid_input_chunk');
      }
      // NativeFrameDecoder deliberately sanitizes consumer failures to a
      // FrameError.  Retain the local, sanitized host code so the boundary
      // does not collapse a worker/output failure into an ambiguous protocol
      // diagnostic.
      let callbackFailure;
      try {
        await decoder.consume(Buffer.from(chunk), async (request) => {
          try {
            let reply;
            workerPending = true;
            try {
              reply = await awaitWithCancellation(() => connector.request(request), cancellation);
            } catch (error) {
              if (error instanceof NativeHostError) throw error;
              throw new NativeHostError('worker_request_failed');
            } finally {
              workerPending = false;
            }
            let validated;
            try {
              validated = assertReply(reply, request.operation);
            } catch {
              throw new NativeHostError('invalid_worker_reply');
            }
            if (validated.request_id !== request.request_id) {
              throw new NativeHostError('worker_reply_mismatch');
            }
            let frame;
            try {
              frame = encodeNativeMessage(validated, (value) => assertReply(value, request.operation));
            } catch {
              throw new NativeHostError('invalid_worker_reply');
            }
            await writeNativeFrame(output, frame, cancellation);
            processed += 1;
          } catch (error) {
            callbackFailure = error instanceof NativeHostError
              ? error
              : new NativeHostError('protocol_failed');
            throw error;
          }
        });
      } catch (error) {
        if (callbackFailure) throw callbackFailure;
        throw error;
      }
    }
    try {
      decoder.finish();
    } catch {
      throw new NativeHostError('truncated_input');
    }
    return Object.freeze({ processed });
  } catch (error) {
    if (error instanceof NativeHostError) throw error;
    throw new NativeHostError('protocol_failed');
  } finally {
    try {
      if (typeof iterator.return === 'function') {
        // A stream iterator may have a pending next() that never resolves
        // after a port close.  Do not await return(); observe any rejection
        // without allowing cleanup itself to hang or become unhandled.
        const returned = iterator.return();
        if (returned && typeof returned.then === 'function') returned.catch(() => {});
      }
    } catch { /* iterator cleanup cannot change the sanitized outcome */ }
    await closeConnector(connector);
    cleanupInput();
    cleanupOutput();
  }
}
