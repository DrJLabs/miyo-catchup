import { ProbeClientError } from './probe-client.mjs';
import { selectedConversationRequest, validateSelectedConversation } from './selected-conversation-contract.mjs';
import { SESSION_URL, exact, boundedId, uuid, failure, awaitAbortable,
  readBoundedJson, decodeJwtPayload, parseSession, digest, base64, classify } from './background-setup-collector.mjs';

const BODY_LIMIT = 64 * 1024 * 1024;
const CHUNK_BYTES = 184320;
const TOKEN_LIFETIME_MS = 60000;

/** One session and one token-bound body; never a cache, catalog or retry client. */
export function createBackgroundSelectedCollector({ binding, conversationId,
  uuid: makeUuid = () => globalThis.crypto.randomUUID(), fetchImpl = globalThis.fetch,
  wallNow = Date.now, monotonicNow = () => performance.now(), timeoutMs = 30000 } = {}) {
  if (!exact(binding, ['principal_id', 'context_id']) || !boundedId(binding.principal_id)
    || !boundedId(binding.context_id) || !boundedId(conversationId)
    || typeof makeUuid !== 'function' || typeof fetchImpl !== 'function'
    || typeof wallNow !== 'function' || typeof monotonicNow !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new ProbeClientError('invalid_probe_configuration');
  }
  const expected = { ...binding };
  const route = selectedConversationRequest(conversationId);
  let collectorInstanceId;
  try { collectorInstanceId = makeUuid(); } catch { /* fixed error below */ }
  if (!uuid(collectorInstanceId)) throw new ProbeClientError('invalid_probe_configuration');
  let stage = 'new';
  let closed = false;
  let active = null;
  let buffer = null;
  let token = null;
  let tokenExpires = 0;
  let sessionWall = 0;
  let sessionMono = 0;
  let lastDispatchMono = null;
  let tokenTimer = null;
  const consumed = new Set();
  const clearToken = () => {
    token = null;
    tokenExpires = 0;
    clearTimeout(tokenTimer);
    tokenTimer = null;
  };
  const dispose = async () => {
    closed = true;
    buffer = null;
    clearToken();
    if (active) {
      const current = active;
      current.controller.abort();
      await current.done;
    }
    return { ok: true };
  };

  async function dispatch(permit) {
    if (closed) return failure('aborted');
    if (active || buffer || !exact(permit, ['permit_id', 'request_kind', 'arguments', 'valid_until'])
      || !uuid(permit.permit_id) || consumed.has(permit.permit_id)
      || typeof permit.valid_until !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(permit.valid_until)) {
      return failure('schema_changed');
    }
    const session = permit.request_kind === 'session_check';
    if (session ? stage !== 'new' || !exact(permit.arguments, [])
      : permit.request_kind !== 'body' || stage !== 'ready'
        || !exact(permit.arguments, ['conversation_ids'])
        || !Array.isArray(permit.arguments.conversation_ids)
        || permit.arguments.conversation_ids.length !== 1
        || permit.arguments.conversation_ids[0] !== conversationId) return failure('schema_changed');
    let now;
    let mono;
    try { now = wallNow(); mono = monotonicNow(); } catch { return failure('schema_changed'); }
    if (!Number.isFinite(now) || !Number.isFinite(mono)
      || !Number.isFinite(Date.parse(permit.valid_until)) || Date.parse(permit.valid_until) <= now
      || (lastDispatchMono !== null && mono - lastDispatchMono < 5000)) return failure('schema_changed');
    if (!session && (!token || now >= tokenExpires || mono - sessionMono < 0
      || mono - sessionMono >= TOKEN_LIFETIME_MS || now < sessionWall
      || Math.abs((now - sessionWall) - (mono - sessionMono)) > 1000)) {
      clearToken(); stage = 'failed'; return failure('identity_mismatch');
    }
    consumed.add(permit.permit_id);
    stage = 'dispatched';
    lastDispatchMono = mono;
    const controller = new AbortController();
    const deadline = { expired: false };
    const timer = setTimeout(() => { deadline.expired = true; controller.abort(); clearToken(); }, timeoutMs);
    const record = { controller, done: null };
    active = record;
    record.done = (async () => {
      let response = null;
      let received = null;
      let bytes = null;
      try {
        response = await awaitAbortable(Promise.resolve().then(() => {
          // Recheck immediately at invocation; no microtask gap may use a stale permit.
          if (closed || controller.signal.aborted || Date.parse(permit.valid_until) <= wallNow()) {
            throw new Error('aborted');
          }
          const init = { method: 'GET', credentials: session ? 'include' : 'omit',
            headers: { accept: 'application/json' }, redirect: 'error', cache: 'no-store',
            referrerPolicy: 'no-referrer', signal: controller.signal };
          if (!session) {
            if (!token || wallNow() >= tokenExpires) throw new Error('identity_mismatch');
            init.headers.authorization = `Bearer ${token}`;
          }
          try { return fetchImpl(session ? SESSION_URL : route.url, init); }
          finally { if (!session) clearToken(); }
        }), controller.signal, deadline);
        received = await readBoundedJson(response, controller.signal, deadline,
          session ? 16384 : BODY_LIMIT, !session);
        response = null;
        if (closed || controller.signal.aborted) throw new Error('aborted');
        if (session) {
          const identity = parseSession(received, expected.principal_id, wallNow);
          if (identity.ok === false) return identity;
          if (identity.context_id !== expected.context_id) return failure('identity_mismatch');
          const claims = decodeJwtPayload(received.accessToken);
          sessionWall = wallNow(); sessionMono = monotonicNow();
          if (!Number.isFinite(sessionWall) || !Number.isFinite(sessionMono)) throw new Error('schema_changed');
          tokenExpires = Math.min(claims.exp * 1000, sessionWall + TOKEN_LIFETIME_MS);
          token = received.accessToken;
          tokenTimer = setTimeout(clearToken, Math.max(0, tokenExpires - sessionWall));
          bytes = new TextEncoder().encode(JSON.stringify(identity));
        } else {
          if (!validateSelectedConversation(received.parsed, conversationId)) throw new Error('schema_changed');
          bytes = received.bytes;
        }
        received = null;
        const sha256 = await awaitAbortable(digest(bytes), controller.signal, deadline);
        if (closed || controller.signal.aborted) throw new Error('aborted');
        const count = Math.ceil(bytes.byteLength / CHUNK_BYTES);
        buffer = { bytes, sha256, count, pulled: -1 };
        stage = session ? 'session_buffer' : 'body_buffer';
        return { ok: true, raw_bytes: bytes.byteLength, chunk_count: count, sha256 };
      } catch (error) { return classify(error); }
      finally {
        // Header/status rejection may happen before a stream reader exists.
        // Cancel it before releasing ownership, including abort-ignoring fakes.
        try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* locked reader */ }
        controller.abort();
        response = null; received = null; bytes = null;
        clearTimeout(timer);
        if (!buffer) { stage = 'failed'; clearToken(); }
        if (active === record) active = null;
      }
    })();
    return record.done;
  }

  async function call(command) {
    if (closed) return failure('aborted');
    if (command?.operation === 'dispatch' && exact(command, ['operation', 'permit'])) return dispatch(command.permit);
    if (command?.operation === 'abort' && exact(command, ['operation'])) return dispose();
    if (command?.operation === 'pull' && exact(command, ['operation', 'sequence'])) {
      const n = command.sequence;
      if (!buffer) return failure('aborted');
      if (!Number.isSafeInteger(n) || n < 0 || n >= buffer.count
        || (n !== buffer.pulled && n !== buffer.pulled + 1)) return failure('schema_changed');
      const chunk = buffer.bytes.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES);
      buffer.pulled = n;
      return { ok: true, sequence: n, decoded_bytes: chunk.byteLength, data: base64(chunk) };
    }
    if (command?.operation === 'release' && exact(command, ['operation'])) {
      if (!buffer || buffer.pulled !== buffer.count - 1) return failure('schema_changed');
      buffer = null;
      stage = stage === 'session_buffer' ? 'ready' : 'complete';
      if (stage === 'complete') clearToken();
      return { ok: true };
    }
    return failure('schema_changed');
  }
  return { collectorInstanceId, call, dispose };
}
