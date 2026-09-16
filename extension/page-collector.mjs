/*
 * The fixed function passed to chrome.scripting.executeScript.
 *
 * This module deliberately has no imports and pageCollector() is self-contained
 * so its function value can be serialized into a MAIN-world executeScript call.
 * The production adapter table is intentionally empty until a real ChatGPT
 * context/body shape has been qualified.  Tests enable only the hard-coded
 * synthetic adapter with the reserved-origin test marker
 * globalThis.__MIYO_CATCHUP_SYNTHETIC_TEST__.
 */
export function pageCollector(command) {
  const STATE_KEY = '__MIYO_CATCHUP_PAGE_COLLECTOR_V1__';
  const SESSION_PATH = '/api/auth/session';
  const BODY_PATH = '/backend-api/conversations/batch';
  const SYNTHETIC_ADAPTER_ID = 'synthetic-v1';
  const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
  const MAX_SESSION_BYTES = 16 * 1024;
  const MAX_RAW_CHUNK_BYTES = 180 * 1024;
  const MIN_DISPATCH_SPACING_MS = 5000;
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const ALLOWED_OPERATIONS = new Set(['initialize', 'dispatch', 'pull', 'release', 'abort']);
  const ALLOWED_REQUEST_KINDS = new Set(['session_check', 'body']);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const plainObject = (value) => value !== null && typeof value === 'object'
    && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
  const keysExactly = (value, keys) => plainObject(value)
    && Object.keys(value).every((key) => keys.includes(key))
    && keys.every((key) => Object.hasOwn(value, key));
  const boundedId = (value) => typeof value === 'string' && ID.test(value);
  const FAILURE_CLASS = new Map([
    ['network', 'network'], ['timeout', 'timeout'], ['rate_limited', 'rate_limited'],
    ['auth_required', 'auth_required'], ['challenge_required', 'challenge'],
    ['aborted', 'aborted'], ['context_mismatch', 'identity_mismatch'],
    ['body_id_mismatch', 'identity_mismatch'], ['closed', 'aborted'], ['lost_buffer', 'aborted'],
  ]);
  const fail = (code, httpStatus, retryAfterValue) => {
    const error = { failure_class: FAILURE_CLASS.get(code) ?? 'schema_changed' };
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) error.http_status = httpStatus;
    if (typeof retryAfterValue === 'string' && retryAfterValue.length <= 128) error.retry_after = retryAfterValue;
    return { ok: false, error };
  };
  const now = () => {
    try {
      if (globalThis.performance && typeof globalThis.performance.now === 'function') {
        return globalThis.performance.now();
      }
    } catch { /* fall through to the browser monotonic fallback */ }
    return null;
  };
  const wallNow = () => {
    try { return Date.now(); } catch { return null; }
  };

  // This is deliberately not a production adapter.  Its fields are synthetic
  // fixtures only; accepting this path requires the VM-only test marker.
  const syntheticAdapter = () => ({
    parseSession(value) {
      if (!plainObject(value) || !plainObject(value.user) || !plainObject(value.context)) return null;
      if (!boundedId(value.user.id) || !boundedId(value.context.id)) return null;
      if (typeof value.token !== 'string' || value.token.length === 0 || value.token.length > 4096
        || !/^[\x21-\x7e]+$/.test(value.token)) return null;
      return { principal_id: value.user.id, context_id: value.context.id, token: value.token };
    },
    validateBody(value, conversationId) {
      return plainObject(value) && plainObject(value.conversation)
        && value.conversation.id === conversationId;
    },
  });

  const adapterFor = (qualification) => {
    if (!plainObject(qualification) || !keysExactly(qualification, ['adapter_id'])
      || qualification.adapter_id !== SYNTHETIC_ADAPTER_ID) return null;
    // The reserved synthetic origin is an additional gate: a real page can
    // assign the marker, but it cannot claim this origin. No adapter, URL,
    // headers or code can be supplied through initialize().
    if (globalThis.__MIYO_CATCHUP_SYNTHETIC_TEST__ !== true
      || globalThis.location?.origin !== 'https://miyo-catchup.invalid') return null;
    return syntheticAdapter();
  };

  const bytesToBase64 = (bytes) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      const n = (a << 16) | (b << 8) | c;
      out += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63]
        + (i + 1 < bytes.length ? alphabet[(n >>> 6) & 63] : '=')
        + (i + 2 < bytes.length ? alphabet[n & 63] : '=');
    }
    return out;
  };

  const hex = (bytes) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

  const retryAfter = (response) => {
    let value;
    try {
      if (!response.headers || typeof response.headers.get !== 'function') return undefined;
      value = response.headers.get('retry-after');
    } catch { return 'invalid'; }
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 128 || /[^\x20-\x7e]/.test(value)) return 'invalid';
    if (/^\d+$/.test(value)) return value;
    if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
      && Number.isFinite(Date.parse(value))) return value;
    return 'invalid';
  };
  const responseError = (code, response) => {
    const error = new Error(code);
    error.httpStatus = response.status;
    if (response.status === 429) error.retryAfter = retryAfter(response);
    throw error;
  };

  const readResponse = async (response, limit, wait) => {
    if (!response || !Number.isInteger(response.status)) throw new Error('http_error');
    if (response.status === 401) responseError('auth_required', response);
    if (response.status === 403) responseError('challenge_required', response);
    if (response.status === 429) responseError('rate_limited', response);
    if (response.status < 200 || response.status >= 300) responseError('http_error', response);
    if (!response.body || typeof response.body.getReader !== 'function') throw new Error('stream_unavailable');
    const reader = response.body.getReader();
    const SEGMENT_BYTES = 64 * 1024;
    const parts = [];
    let segment = new Uint8Array(SEGMENT_BYTES);
    let segmentBytes = 0;
    let total = 0;
    try {
      while (true) {
        const item = await wait(reader.read());
        if (!item || typeof item !== 'object') throw new Error('invalid_stream');
        if (item.done) break;
        if (!item.value || !Number.isInteger(item.value.byteLength) || item.value.byteLength < 0) throw new Error('invalid_stream');
        if (total + item.value.byteLength > limit) throw new Error('response_too_large');
        const part = new Uint8Array(item.value);
        if (part.byteLength !== item.value.byteLength) throw new Error('invalid_stream');
        let offset = 0;
        while (offset < part.byteLength) {
          const count = Math.min(SEGMENT_BYTES - segmentBytes, part.byteLength - offset);
          segment.set(part.subarray(offset, offset + count), segmentBytes);
          segmentBytes += count;
          offset += count;
          if (segmentBytes === SEGMENT_BYTES) {
            parts.push(segment);
            segment = new Uint8Array(SEGMENT_BYTES);
            segmentBytes = 0;
          }
        }
        total += part.byteLength;
      }
    } catch (error) {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* no diagnostics from cleanup */ }
      throw error;
    }
    if (segmentBytes) parts.push(segment.subarray(0, segmentBytes));
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return bytes;
  };

  const jsonFromBytes = (bytes) => {
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return JSON.parse(text);
    } catch { throw new Error('invalid_response'); }
  };

  const digest = async (bytes) => {
    if (!globalThis.crypto || !globalThis.crypto.subtle
      || typeof globalThis.crypto.subtle.digest !== 'function') throw new Error('crypto_unavailable');
    return hex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  };

  const classify = (error) => {
    const code = error instanceof Error ? error.message : '';
    const allowed = new Set([
      'auth_required', 'challenge_required', 'rate_limited', 'http_error', 'network',
      'stream_unavailable', 'invalid_stream', 'response_too_large', 'invalid_response',
      'crypto_unavailable', 'aborted', 'timeout',
    ]);
    return fail(allowed.has(code) ? code : 'network', error?.httpStatus, error?.retryAfter);
  };

  let existing;
  try { existing = globalThis[STATE_KEY]; } catch { return fail('closed'); }
  if (existing && typeof existing.invoke === 'function') return existing.invoke(command);

  let initialized = false;
  let closed = false;
  let binding = null;
  let conversationId = null;
  let adapter = null;
  let sessionVerified = false;
  let bodyFetched = false;
  let sessionToken = null; // closure-only marker; never serialized or returned
  let transfer = null;
  let expectedSequence = 0;
  let lastDispatchAt = null;
  let activeController = null;
  let cancelActive = null;
  const consumedPermits = new Set();

  const clearTransfer = () => {
    transfer = null;
    expectedSequence = 0;
  };

  const invoke = async (value) => {
    if (globalThis.location?.origin !== 'https://miyo-catchup.invalid') return fail('unqualified_adapter');
    if (!plainObject(value) || typeof value.operation !== 'string' || !ALLOWED_OPERATIONS.has(value.operation)) return fail('invalid_command');
    if (value.operation === 'abort') {
      if (!keysExactly(value, ['operation'])) return fail('invalid_command');
      closed = true;
      if (activeController) {
        try { activeController.abort(); } catch { /* abort is best effort */ }
      }
      if (cancelActive) cancelActive('aborted');
      activeController = null;
      clearTransfer();
      sessionToken = null;
      sessionVerified = false;
      return { ok: true };
    }
    if (closed) return fail('closed');

    if (value.operation === 'initialize') {
      if (!keysExactly(value, ['operation', 'binding', 'conversation_id', 'qualification']) || initialized) return fail('invalid_command');
      if (!plainObject(value.binding) || !keysExactly(value.binding, ['principal_id', 'context_id'])
        || !boundedId(value.binding.principal_id) || !boundedId(value.binding.context_id)
        || !boundedId(value.conversation_id)) return fail('invalid_binding');
      const selectedAdapter = adapterFor(value.qualification);
      if (!selectedAdapter) return fail('unqualified_adapter');
      initialized = true;
      binding = { principal_id: value.binding.principal_id, context_id: value.binding.context_id };
      conversationId = value.conversation_id;
      adapter = selectedAdapter;
      return { ok: true };
    }

    if (!initialized) return fail('uninitialized');
    if (value.operation === 'dispatch') {
      if (!keysExactly(value, ['operation', 'permit']) || !plainObject(value.permit)
        || !keysExactly(value.permit, ['permit_id', 'request_kind', 'arguments', 'valid_until'])
        || !UUID.test(value.permit.permit_id) || !ALLOWED_REQUEST_KINDS.has(value.permit.request_kind)
        || !plainObject(value.permit.arguments) || typeof value.permit.valid_until !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value.permit.valid_until)
        || !Number.isFinite(Date.parse(value.permit.valid_until))) return fail('invalid_permit');
      if (activeController) return fail('busy');
      const permit = value.permit;
      const expiryNow = wallNow();
      if (!Number.isFinite(expiryNow)) return fail('clock_untrusted');
      if (expiryNow > Date.parse(permit.valid_until)) return fail('permit_expired');
      if (consumedPermits.has(permit.permit_id)) return fail('permit_replayed');
      if (transfer) return fail('buffer_not_drained');
      const expectedArguments = permit.request_kind === 'session_check' ? [] : ['conversation_ids'];
      if (!keysExactly(permit.arguments, expectedArguments)) return fail('invalid_permit');
      if (permit.request_kind === 'body' && (!Array.isArray(permit.arguments.conversation_ids)
        || permit.arguments.conversation_ids.length !== 1
        || permit.arguments.conversation_ids[0] !== conversationId)) return fail('body_id_mismatch');
      if (permit.request_kind === 'session_check' && sessionVerified) return fail('session_already_verified');
      if (permit.request_kind === 'body' && (!sessionVerified || bodyFetched)) return fail(sessionVerified ? 'body_already_fetched' : 'session_required');
      const start = now();
      if (!Number.isFinite(start)) return fail('clock_untrusted');
      if (lastDispatchAt !== null && start - lastDispatchAt < MIN_DISPATCH_SPACING_MS) return fail('dispatch_spacing');
      consumedPermits.add(permit.permit_id);
      lastDispatchAt = start;
      activeController = typeof AbortController === 'function' ? new AbortController() : null;
      const controller = activeController;
      let pendingReject = null;
      let timedOut = false;
      // One removable waiter, not one reaction to a never-settled timeout
      // promise per stream read. Tiny chunks must not grow a promise queue.
      const wait = (promise) => new Promise((resolve, reject) => {
        const finish = (fn, value) => {
          if (pendingReject === cancel) pendingReject = null;
          fn(value);
        };
        const cancel = (error) => finish(reject, error);
        pendingReject = cancel;
        Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
        if (closed) cancel(new Error('aborted'));
        else if (timedOut || now() - start >= 30000) cancel(new Error('timeout'));
      });
      cancelActive = (reason) => { if (pendingReject) pendingReject(new Error(reason)); };
      const timer = setTimeout(() => {
        timedOut = true;
        try { controller?.abort(); } catch { /* timeout remains a bounded failure */ }
        cancelActive?.('timeout');
      }, 30_000);
      try {
        let response;
        try {
          const fetchPromise = permit.request_kind === 'session_check'
            ? globalThis.fetch(SESSION_PATH, { method: 'GET', credentials: 'same-origin', signal: controller?.signal })
            : globalThis.fetch(BODY_PATH, {
              method: 'POST', credentials: 'same-origin', signal: controller?.signal,
              headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
              body: JSON.stringify({ conversation_ids: [conversationId] }),
            });
          response = await wait(fetchPromise);
        } catch (error) {
          if (timedOut) return fail('timeout');
          if (closed || (error && error.name === 'AbortError')) return fail('aborted');
          return fail('network');
        }
        const bytes = await readResponse(response, permit.request_kind === 'session_check' ? MAX_SESSION_BYTES : MAX_RESPONSE_BYTES, wait);
        if (closed) return fail('aborted');
        if (bytes.byteLength === 0) return fail('invalid_response');
        if (permit.request_kind === 'session_check') {
          const parsed = jsonFromBytes(bytes);
          const outcome = adapter.parseSession(parsed);
          if (!outcome || outcome.principal_id !== binding.principal_id || outcome.context_id !== binding.context_id) return fail('context_mismatch');
          const sanitizedOutcome = { principal_id: outcome.principal_id, context_id: outcome.context_id };
          const sanitized = new TextEncoder().encode(JSON.stringify(sanitizedOutcome));
          const sessionDigest = await wait(digest(sanitized));
          sessionToken = outcome.token;
          sessionVerified = true;
          transfer = { bytes: sanitized, digest: sessionDigest, kind: 'session',
            chunk_count: Math.max(1, Math.ceil(sanitized.byteLength / MAX_RAW_CHUNK_BYTES)) };
        } else {
          const parsed = jsonFromBytes(bytes);
          if (!adapter.validateBody(parsed, conversationId)) return fail('body_invalid');
          const bodyDigest = await wait(digest(bytes));
          bodyFetched = true;
          transfer = { bytes, digest: bodyDigest, kind: 'body',
            chunk_count: Math.max(1, Math.ceil(bytes.byteLength / MAX_RAW_CHUNK_BYTES)) };
        }
        expectedSequence = 0;
        return { ok: true, raw_bytes: transfer.bytes.byteLength,
          chunk_count: transfer.chunk_count, sha256: transfer.digest };
      } catch (error) {
        if (timedOut) return fail('timeout');
        if (closed || (error && error.name === 'AbortError')) return fail('aborted');
        return classify(error);
      } finally {
        clearTimeout(timer);
        cancelActive = null;
        if (activeController === controller) activeController = null;
      }
    }

    if (value.operation === 'pull') {
      if (!keysExactly(value, ['operation', 'sequence']) || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return fail('invalid_command');
      if (!transfer) return fail('lost_buffer');
      if (value.sequence >= transfer.chunk_count) return fail('sequence_mismatch');
      if (value.sequence > expectedSequence) return fail('sequence_mismatch');
      const start = value.sequence * MAX_RAW_CHUNK_BYTES;
      const bytes = transfer.bytes.subarray(start, Math.min(start + MAX_RAW_CHUNK_BYTES, transfer.bytes.length));
      const result = { ok: true, sequence: value.sequence, decoded_bytes: bytes.length, data: bytesToBase64(bytes) };
      if (value.sequence === expectedSequence) expectedSequence += 1;
      return result;
    }

    if (value.operation === 'release') {
      if (!keysExactly(value, ['operation'])) return fail('invalid_command');
      if (activeController) return fail('busy');
      if (transfer && expectedSequence !== transfer.chunk_count) return fail('buffer_not_drained');
      if (transfer) clearTransfer();
      if (bodyFetched) sessionToken = null;
      return { ok: true };
    }
    return fail('invalid_command');
  };

  try {
    Object.defineProperty(globalThis, STATE_KEY, { value: { invoke }, enumerable: false, configurable: false, writable: false });
  } catch {
    return fail('closed');
  }
  return invoke(command);
}
