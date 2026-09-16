import { ProbeClientError } from './probe-client.mjs';

const SESSION_URL = 'https://chatgpt.com/api/auth/session';
const MAX_SESSION_BYTES = 16 * 1024;
const MAX_RETRY_AFTER = 128;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VALID_FAILURES = new Set([
  'network', 'timeout', 'rate_limited', 'auth_required', 'challenge',
  'schema_changed', 'identity_mismatch', 'aborted',
]);

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, required, optional = []) {
  return plain(value) && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function boundedId(value) { return typeof value === 'string' && ID.test(value); }

function uuid(value) { return typeof value === 'string' && UUID.test(value); }

function failure(failureClass, extras = {}) {
  if (!VALID_FAILURES.has(failureClass)) failureClass = 'schema_changed';
  const error = { failure_class: failureClass };
  if (Number.isSafeInteger(extras.http_status) && extras.http_status >= 100 && extras.http_status <= 599) {
    error.http_status = extras.http_status;
  }
  if (typeof extras.retry_after === 'string' && extras.retry_after.length <= MAX_RETRY_AFTER) {
    error.retry_after = extras.retry_after;
  }
  return { ok: false, error };
}

function retryAfter(response) {
  let value;
  try {
    value = response?.headers?.get?.('retry-after');
  } catch {
    return 'invalid';
  }
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_RETRY_AFTER || /[^\x20-\x7e]/.test(value)) return 'invalid';
  if (/^\d+$/.test(value)) return value;
  if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
    && Number.isFinite(Date.parse(value))) return value;
  return 'invalid';
}

function responseContentTypeIsJson(response) {
  if (response?.redirected === true || response?.type === 'opaqueredirect') return false;
  let contentType;
  try { contentType = response?.headers?.get?.('content-type'); } catch { return false; }
  return typeof contentType === 'string'
    && /^application\/json(?:\s*;\s*charset\s*=\s*[A-Za-z0-9._-]+)?\s*$/i.test(contentType);
}

async function awaitAbortable(value, signal, deadline) {
  if (signal.aborted) throw new Error(deadline.expired ? 'timeout' : 'aborted');
  let rejectAbort;
  const abort = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new Error(deadline.expired ? 'timeout' : 'aborted'));
  try {
    signal.addEventListener('abort', onAbort, { once: true });
    return await Promise.race([Promise.resolve(value), abort]);
  } finally {
    try { signal.removeEventListener('abort', onAbort); } catch { /* signal is browser-owned */ }
  }
}

async function readBoundedJson(response, signal, deadline) {
  if (!response || !Number.isInteger(response.status)) throw new Error('schema_changed');
  if (response.status === 401) throw Object.assign(new Error('auth_required'), { httpStatus: 401 });
  if (response.status === 403) throw Object.assign(new Error('challenge'), { httpStatus: 403 });
  if (response.status === 429) {
    throw Object.assign(new Error('rate_limited'), {
      httpStatus: 429, retryAfter: retryAfter(response),
    });
  }
  if (response.status !== 200 || !responseContentTypeIsJson(response)) throw new Error('schema_changed');
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('schema_changed');
  const reader = response.body.getReader();
  let chunks = [];
  let bytes = null;
  let text = null;
  let total = 0;
  let cancelRequested = false;
  const dropRaw = () => { chunks = []; bytes = null; text = null; };
  const requestCancel = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    dropRaw();
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* bounded cleanup only */ }
  };
  const onAbort = () => { requestCancel(); };
  try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* signal is browser-owned */ }
  try {
    while (true) {
      if (signal.aborted || deadline.expired) throw new Error(deadline.expired ? 'timeout' : 'aborted');
      const item = await awaitAbortable(reader.read(), signal, deadline);
      if (!item || typeof item !== 'object') throw new Error('schema_changed');
      if (item.done) break;
      if (!ArrayBuffer.isView(item.value) || item.value.byteLength < 0) throw new Error('schema_changed');
      if (total + item.value.byteLength > MAX_SESSION_BYTES) throw new Error('schema_changed');
      const bytes = new Uint8Array(item.value.buffer, item.value.byteOffset, item.value.byteLength);
      chunks.push(new Uint8Array(bytes));
      total += bytes.byteLength;
    }
  } catch (error) {
    requestCancel();
    throw error;
  } finally {
    try { signal.removeEventListener('abort', onAbort); } catch { /* signal is browser-owned */ }
  }
  if (signal.aborted || deadline.expired) throw new Error(deadline.expired ? 'timeout' : 'aborted');
  bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return JSON.parse(text);
  } catch { throw new Error('schema_changed'); }
  finally { dropRaw(); }
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 16384) return null;
  const pieces = token.split('.');
  if (pieces.length !== 3 || pieces.some((piece) => !/^[A-Za-z0-9_-]+$/.test(piece))) return null;
  const encoded = pieces[1];
  if (encoded.length === 0 || encoded.length > 8192 || encoded.length % 4 === 1) return null;
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - (encoded.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = JSON.parse(text);
    return plain(value) ? value : null;
  } catch { return null; }
}

function parseSession(value, expectedPrincipal, wallNow) {
  if (!plain(value) || !plain(value.user) || !plain(value.account)
    || Object.hasOwn(value, 'error') || Object.hasOwn(value, 'workspaceTokenExchangeError')) {
    return failure('schema_changed');
  }
  if (!boundedId(value.user.id) || !boundedId(value.account.id)
    || value.user.id !== expectedPrincipal || value.account.structure !== 'personal') {
    return failure('identity_mismatch');
  }
  const payload = decodeJwtPayload(value.accessToken);
  const auth = payload?.['https://api.openai.com/auth'];
  const now = Number(wallNow());
  if (!plain(auth) || auth.chatgpt_account_id !== value.account.id
    || !Number.isFinite(payload?.exp) || !Number.isFinite(now) || payload.exp <= now / 1000) {
    return failure('identity_mismatch');
  }
  return { principal_id: value.user.id, context_id: value.account.id };
}

async function digest(bytes) {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.subtle.digest !== 'function') {
    throw new Error('schema_changed');
  }
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function classify(error) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'auth_required' || code === 'challenge' || code === 'rate_limited') {
    return failure(code, { http_status: error.httpStatus, retry_after: error.retryAfter });
  }
  if (code === 'timeout' || code === 'aborted' || code === 'identity_mismatch' || code === 'schema_changed') {
    return failure(code);
  }
  return failure('network');
}

function invalidConfiguration() { throw new ProbeClientError('invalid_probe_configuration'); }

export function createBackgroundSetupCollector({ binding, uuid: makeUuid = () => globalThis.crypto.randomUUID(),
  fetchImpl = globalThis.fetch, timeoutMs = 30000, wallNow = Date.now } = {}) {
  if (!exact(binding, ['principal_id', 'context_id']) || !boundedId(binding.principal_id)
    || binding.context_id !== null || typeof makeUuid !== 'function' || typeof fetchImpl !== 'function'
    || typeof wallNow !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    invalidConfiguration();
  }
  let collectorInstanceId;
  try { collectorInstanceId = makeUuid(); } catch { invalidConfiguration(); }
  if (!uuid(collectorInstanceId)) invalidConfiguration();
  const expectedPrincipal = binding.principal_id;

  let closed = false;
  let dispatchUsed = false;
  let buffer = null;
  let active = null;

  const dispose = async () => {
    if (closed) return { ok: true };
    closed = true;
    buffer = null;
    if (active) {
      const current = active;
      current.cancel('aborted');
      try { current.controller.abort(); } catch { /* best effort */ }
      await current.taskDone;
      if (active === current) active = null;
    }
    return { ok: true };
  };

  const dispatch = async (permit) => {
    if (closed) return failure('aborted');
    if (dispatchUsed || active) return failure('schema_changed');
    if (!exact(permit, ['permit_id', 'request_kind', 'arguments', 'valid_until'])
      || !uuid(permit.permit_id) || permit.request_kind !== 'session_check'
      || !exact(permit.arguments, []) || typeof permit.valid_until !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(permit.valid_until)) {
      return failure('schema_changed');
    }
    let now;
    try { now = Number(wallNow()); } catch { return failure('schema_changed'); }
    if (!Number.isFinite(now) || !Number.isFinite(Date.parse(permit.valid_until))
      || Date.parse(permit.valid_until) <= now) return failure('schema_changed');
    if (typeof AbortController !== 'function') return failure('schema_changed');
    dispatchUsed = true;
    const controller = new AbortController();
    const deadline = { expired: false };
    let resolveGate;
    let settled = false;
    const gate = new Promise((resolve) => { resolveGate = resolve; });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveGate(result);
    };
    const timer = setTimeout(() => {
      deadline.expired = true;
      try { controller.abort(); } catch { /* bounded timeout */ }
      finish(failure('timeout'));
    }, timeoutMs);
    const record = {
      controller,
      cancel: (code) => finish(failure(code)),
      done: gate,
    };
    active = record;
    const task = (async () => {
      let response;
      let parsed;
      try {
        try {
          response = await awaitAbortable(Promise.resolve().then(() => fetchImpl(SESSION_URL, {
            method: 'GET', credentials: 'include',
            headers: { accept: 'application/json' },
            redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
            signal: controller.signal,
          })), controller.signal, deadline);
        } catch (error) {
          if (deadline.expired) throw new Error('timeout');
          if (closed || controller.signal.aborted) throw new Error('aborted');
          throw error;
        }
        parsed = await readBoundedJson(response, controller.signal, deadline);
        response = null;
        if (closed || controller.signal.aborted) throw new Error('aborted');
        const outcome = parseSession(parsed, expectedPrincipal, wallNow);
        // Only the canonical identity survives beyond this point; the parsed
        // session object may contain accessToken, email, or other credentials.
        parsed = null;
        if (outcome?.ok === false) return outcome;
        const bytes = new TextEncoder().encode(JSON.stringify(outcome));
        const sha256 = await awaitAbortable(digest(bytes), controller.signal, deadline);
        if (closed || controller.signal.aborted) throw new Error('aborted');
        return { ok: true, raw_bytes: bytes.byteLength, chunk_count: 1, sha256, bytes };
      } catch (error) {
        return classify(error);
      } finally {
        response = null;
        parsed = null;
      }
    })();
    record.taskDone = task;
    task.then((result) => {
      clearTimeout(timer);
      if (!settled && result.ok === true) {
        buffer = { bytes: result.bytes, data: base64(result.bytes), raw_bytes: result.raw_bytes,
          sha256: result.sha256, pulled: false };
      }
      if (!settled) finish(result.ok === true ? { ok: true, raw_bytes: result.raw_bytes,
        chunk_count: result.chunk_count, sha256: result.sha256 } : result);
      if (active === record) active = null;
    }, () => {
      clearTimeout(timer);
      if (!settled) finish(failure('network'));
      if (active === record) active = null;
    });
    const result = await gate;
    clearTimeout(timer);
    return result;
  };

  const call = async (command) => {
    if (closed) return failure('aborted');
    if (!plain(command) || typeof command.operation !== 'string') return failure('schema_changed');
    if (command.operation === 'dispatch') {
      if (!exact(command, ['operation', 'permit'])) return failure('schema_changed');
      return dispatch(command.permit);
    }
    if (command.operation === 'pull') {
      if (!exact(command, ['operation', 'sequence']) || command.sequence !== 0 || !buffer) {
        return failure(buffer ? 'schema_changed' : 'aborted');
      }
      buffer.pulled = true;
      return { ok: true, sequence: 0, decoded_bytes: buffer.bytes.byteLength, data: buffer.data };
    }
    if (command.operation === 'release') {
      if (!exact(command, ['operation']) || !buffer || !buffer.pulled) return failure('schema_changed');
      buffer = null;
      return { ok: true };
    }
    if (command.operation === 'abort' && exact(command, ['operation'])) return dispose();
    return failure('schema_changed');
  };

  return { collectorInstanceId, call, dispose };
}
