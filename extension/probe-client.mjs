// Browser-only T02 control flow. No ambient Chrome access, automatic startup,
// discovery, retries, publication, or production configuration defaults.
const HOST = 'local.miyo_chatgpt_catchup';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const FAILURES = ['network', 'timeout', 'rate_limited', 'auth_required', 'challenge',
  'schema_changed', 'identity_mismatch', 'aborted'];

export class ProbeClientError extends Error {
  constructor(code) { super(code); this.name = 'ProbeClientError'; this.code = code; }
}

function reject() { throw new ProbeClientError('invalid_probe_message'); }
function keys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) reject();
}
function text(value, pattern) { if (typeof value !== 'string' || !pattern.test(value)) reject(); }
function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) reject();
}
function boundedJson(value, limit) {
  // Browser-side preflight before JSON.stringify: no getters/toJSON, deep
  // structures, huge strings or aggregate overflow. Native validation remains
  // independent; this protects the earlier extension-to-native leg.
  let count = 0;
  let bytes = 0;
  const add = (size) => { bytes += size; if (bytes > limit) reject(); };
  function string(item) {
    if (item.length > limit) reject();
    add(2);
    for (let i = 0; i < item.length; i += 1) {
      const c = item.charCodeAt(i);
      if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) add(2);
      else if (c < 32) add(6);
      else if (c < 128) add(1);
      else if (c < 2048) add(2);
      else if (c >= 0xd800 && c <= 0xdbff && item.charCodeAt(i + 1) >= 0xdc00 && item.charCodeAt(i + 1) <= 0xdfff) {
        add(4); i += 1;
      } else add(c >= 0xd800 && c <= 0xdfff ? 6 : 3);
    }
  }
  function inspect(item, depth) {
    if (++count > 128 || depth > 8) reject();
    if (item === null) { add(4); return; }
    if (typeof item === 'string') { string(item); return; }
    if (typeof item === 'boolean') { add(item ? 4 : 5); return; }
    if (typeof item === 'number' && Number.isFinite(item)) { add(String(item).length); return; }
    if (typeof item !== 'object') reject();
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype)) reject();
    const names = Reflect.ownKeys(item);
    if (names.length > 128 || names.some((name) => typeof name !== 'string')) reject();
    if (array && (item.length > 127 || names.length !== item.length + 1)) reject();
    add(2);
    const entries = array ? Array.from({ length: item.length }, (_, i) => String(i)) : names;
    entries.forEach((name, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject();
      if (index) add(1);
      if (!array) { string(name); add(1); }
      inspect(descriptor.value, depth + 1);
    });
  }
  inspect(value, 0);
}
function control(value) { boundedJson(value, 16384); }

/** One outstanding native message, with no replay on timeout or port loss. */
export function createNativeClient(chromeApi, { timeoutMs = 30000 } = {}) {
  integer(timeoutMs, 1, 30000);
  const port = chromeApi.runtime.connectNative(HOST);
  let pending = null;
  let closed = false;
  const finish = (error, reply) => {
    if (!pending) return;
    const active = pending;
    pending = null;
    clearTimeout(active.timer);
    if (error) active.reject(error); else active.resolve(reply);
  };
  const fail = () => {
    closed = true;
    finish(new ProbeClientError('dispatch_uncertain'));
  };
  const onMessage = (reply) => {
    try {
      control(reply);
      keys(reply, ['protocol_version', 'request_id', 'ok'], ['result', 'error']);
      if (!pending || reply.protocol_version !== 1 || reply.request_id !== pending.id
        || typeof reply.ok !== 'boolean') reject();
      if (reply.ok) {
        if (!Object.hasOwn(reply, 'result') || Object.hasOwn(reply, 'error')) reject();
      } else {
        if (Object.hasOwn(reply, 'result')) reject();
        keys(reply.error, ['code'], ['retry_at']);
        text(reply.error.code, /^[a-z_]{1,64}$/);
      }
      finish(null, reply);
    } catch { fail(); port.disconnect(); }
  };
  const onDisconnect = () => {
    // Reading lastError consumes Chrome's diagnostic without logging its text.
    void chromeApi.runtime.lastError;
    fail();
  };
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
  return {
    request(message) {
      if (closed) return Promise.reject(new ProbeClientError('dispatch_uncertain'));
      if (pending) return Promise.reject(new ProbeClientError('busy'));
      boundedJson(message, 262144);
      text(message?.request_id, UUID);
      return new Promise((resolve, rejectPromise) => {
        pending = { id: message.request_id, resolve, reject: rejectPromise,
          timer: setTimeout(() => { fail(); port.disconnect(); }, timeoutMs) };
        try { port.postMessage(message); } catch { fail(); port.disconnect(); }
      });
    },
    close() {
      fail();
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      port.disconnect();
    },
  };
}

function failurePayload(value) {
  keys(value, ['failure_class'], ['http_status', 'retry_after']);
  if (!FAILURES.includes(value.failure_class)) reject();
  if (value.http_status !== undefined) integer(value.http_status, 100, 599);
  if (value.retry_after !== undefined && (typeof value.retry_after !== 'string' || value.retry_after.length > 128)) reject();
  return { ...value };
}

/**
 * Run one explicitly configured probe against injected boundaries. `page.call`
 * must target an already initialized, positively owned document. A rejected
 * result, lost ACK, or lost document ends the probe; it never fetches again.
 */
export async function runProbe(options = {}) {
  return runQualification(options, 'conversation');
}

/** Session-only qualification: never advertise, claim, permit or dispatch body work. */
export async function runSessionCheck(options = {}) {
  return runQualification(options, 'session');
}

/** Setup inspection discovers the current personal context without body work. */
export async function runSetupInspection(options = {}) {
  return runQualification(options, 'setup');
}

/** Background setup still requires the worker's durable dispatch ACK. */
export async function runBackgroundSetupInspection(options = {}) {
  return runQualification(options, 'background-setup');
}

export async function runBackgroundSelectedProbe(options = {}) {
  return runQualification(options, 'background-selected');
}

async function runQualification({ request, page, collector, browserInstanceId, binding,
  conversationId,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  persistFailure, uuid = () => crypto.randomUUID() }, mode) {
  const backgroundSetup = mode === 'background-setup';
  const backgroundSelected = mode === 'background-selected';
  const background = backgroundSetup || backgroundSelected;
  const sessionOnly = mode === 'session' || mode === 'setup' || backgroundSetup;
  const setupOnly = mode === 'setup' || backgroundSetup;
  const source = background ? collector : page;
  if (typeof request !== 'function' || typeof source?.call !== 'function'
    || typeof persistFailure !== 'function' || typeof wait !== 'function') reject();
  text(browserInstanceId, UUID);
  if (!sessionOnly) text(conversationId, ID);
  if (background) text(source.collectorInstanceId, UUID);
  else text(source.documentId, ID);
  keys(binding, ['principal_id', 'context_id']);
  text(binding.principal_id, ID);
  if (setupOnly) {
    if (binding.context_id !== null) reject();
  } else text(binding.context_id, ID);
  async function send(operation, payload, fence = {}) {
    const message = { protocol_version: 1, request_id: uuid(), operation, payload, ...fence };
    const reply = await request(message);
    control(reply);
    keys(reply, ['protocol_version', 'request_id', 'ok'], ['result', 'error']);
    if (reply.protocol_version !== 1 || reply.request_id !== message.request_id || reply.ok !== true) {
      throw new ProbeClientError('probe_blocked');
    }
    if (Object.hasOwn(reply, 'error') || !Object.hasOwn(reply, 'result')) reject();
    return reply.result;
  }
  const receipts = [];
  try {
    const hello = await send('hello', { extension_version: '0.0.0', browser_instance_id: browserInstanceId,
      capabilities: backgroundSelected
        ? ['session_check', 'body', 'chunking', 'background_session_check', 'background_selected_body']
        : backgroundSetup ? ['session_check', 'chunking', 'background_session_check']
        : sessionOnly ? ['session_check', 'chunking'] : ['session_check', 'body', 'chunking'] });
    keys(hello, ['worker_instance_id', 'protocol_version', 'config_version']);
    text(hello.worker_instance_id, UUID);
    if (hello.protocol_version !== 1 || hello.config_version !== 1) reject();
    for (const kind of sessionOnly ? ['session_check'] : ['session_check', 'body']) {
      if (kind === 'body') await wait(10000); // grant validity plus dispatch spacing
      const claimed = await send('claim_work', { browser_instance_id: browserInstanceId,
        principal_id: kind === 'body' ? binding.principal_id : null,
        context_id: kind === 'body' ? binding.context_id : null });
      keys(claimed, ['lease']);
      keys(claimed.lease, ['run_id', 'attempt_id', 'lease_generation', 'lease_expires_at', 'work_unit']);
      const lease = claimed.lease;
      text(lease.run_id, UUID); text(lease.attempt_id, UUID); text(lease.work_unit, ID);
      integer(lease.lease_generation, 0, Number.MAX_SAFE_INTEGER);
      const fence = { run_id: lease.run_id, attempt_id: lease.attempt_id, lease_generation: lease.lease_generation };
      const permit = await send('request_permit', { work_unit_id: lease.work_unit }, fence);
      keys(permit, ['granted', 'permit_id', 'request_kind', 'arguments', 'valid_until']);
      if (permit.granted !== true || permit.request_kind !== kind) reject();
      text(permit.permit_id, UUID);
      if (typeof permit.valid_until !== 'string' || !Number.isFinite(Date.parse(permit.valid_until))) reject();
      if (kind === 'session_check') keys(permit.arguments, []);
      else {
        keys(permit.arguments, ['conversation_ids']);
        if (!Array.isArray(permit.arguments.conversation_ids) || permit.arguments.conversation_ids.length !== 1) reject();
        text(permit.arguments.conversation_ids[0], ID);
        if (permit.arguments.conversation_ids[0] !== conversationId) reject();
      }
      fence.permit_id = permit.permit_id;
      const started = await send('dispatch_started', { browser_instance_id: browserInstanceId,
        ...(background ? { collector_instance_id: source.collectorInstanceId }
          : { document_id: source.documentId }) }, fence);
      keys(started, ['accepted']);
      if (started.accepted !== true) reject();
      const result = await source.call({ operation: 'dispatch', permit: {
        permit_id: permit.permit_id, request_kind: kind, arguments: permit.arguments, valid_until: permit.valid_until } });
      control(result);
      if (result?.ok === false) {
        keys(result, ['ok', 'error']);
        const payload = failurePayload(result.error);
        // Store first: if host acknowledgement is lost, this bounded receipt
        // can be reconciled later. Neither auth bytes nor raw exceptions fit.
        const failed = { protocol_version: 1, request_id: uuid(), operation: 'request_failed', payload, ...fence };
        await persistFailure(failed);
        try {
          const ack = await request(failed);
          control(ack);
          keys(ack, ['protocol_version', 'request_id', 'ok', 'result']);
          if (ack.protocol_version !== 1 || ack.request_id !== failed.request_id || ack.ok !== true) reject();
          keys(ack.result, ['recorded']);
          if (ack.result.recorded !== true) reject();
        } catch {
          // Rejection, malformed replies and transport loss all leave durable
          // recording uncertain. Keep the original saved receipt; never retry.
          throw new ProbeClientError('dispatch_uncertain');
        }
        throw new ProbeClientError('probe_failed');
      }
      keys(result, ['ok', 'raw_bytes', 'chunk_count', 'sha256']);
      if (result.ok !== true) reject();
      const resultLimit = kind === 'session_check' ? 16384 : 67108864;
      integer(result.raw_bytes, 1, resultLimit);
      integer(result.chunk_count, 1, Math.ceil(resultLimit / 184320));
      text(result.sha256, SHA);
      let bytes = 0;
      for (let sequence = 0; sequence < result.chunk_count; sequence += 1) {
        const chunk = await source.call({ operation: 'pull', sequence });
        keys(chunk, ['ok', 'sequence', 'decoded_bytes', 'data']);
        if (chunk.ok !== true || chunk.sequence !== sequence) reject();
        integer(chunk.decoded_bytes, 1, Math.min(resultLimit, 184320));
        if (typeof chunk.data !== 'string' || chunk.data.length > 245760
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)) reject();
        const decoded = atob(chunk.data);
        if (decoded.length !== chunk.decoded_bytes || btoa(decoded) !== chunk.data) reject();
        if (kind === 'session_check') {
          // Session results must fit one bounded chunk and contain only the
          // configured identity/context outcome, before any native forwarding.
          let outcome;
          let serialized;
          try {
            const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
            serialized = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
            outcome = JSON.parse(serialized);
          } catch { reject(); }
          keys(outcome, ['principal_id', 'context_id']);
          text(outcome.principal_id, ID);
          text(outcome.context_id, ID);
          if (outcome.principal_id !== binding.principal_id
            || (!setupOnly && outcome.context_id !== binding.context_id)) reject();
          // Do not forward hidden duplicate keys or discarded JSON bytes just
          // because the parsed object happens to have the expected identity.
          if (serialized !== JSON.stringify(outcome)) reject();
        }
        bytes += chunk.decoded_bytes;
        if (bytes > result.raw_bytes) reject();
        const ack = await send('result_chunk', { sequence, decoded_bytes: chunk.decoded_bytes, data: chunk.data }, fence);
        keys(ack, ['next_sequence']);
        if (ack.next_sequence !== sequence + 1) reject();
      }
      if (bytes !== result.raw_bytes) reject();
      if (setupOnly) {
        const released = await source.call({ operation: 'release' });
        keys(released, ['ok']);
        if (released.ok !== true) reject();
      }
      const receipt = await send('commit_result', {
        raw_bytes: result.raw_bytes, chunk_count: result.chunk_count, sha256: result.sha256 }, fence);
      keys(receipt, ['artifact_id', 'raw_bytes', 'sha256']);
      text(receipt.artifact_id, UUID);
      if (receipt.raw_bytes !== result.raw_bytes || receipt.sha256 !== result.sha256) reject();
      receipts.push(receipt);
      if (!setupOnly) {
        const released = await source.call({ operation: 'release' });
        keys(released, ['ok']);
        if (released.ok !== true) reject();
      }
    }
    return { state: backgroundSelected ? 'background_probe_complete'
      : backgroundSetup ? 'background_setup_inspection_complete'
      : setupOnly ? 'setup_inspection_complete' : sessionOnly ? 'session_check_complete' : 'probe_complete', receipts };
  } catch (error) {
    // Chrome/fetch/transport exceptions may contain private page or path text.
    if (error instanceof ProbeClientError) throw error;
    throw new ProbeClientError('dispatch_uncertain');
  } finally {
    // No tab closing/reconnect/refetch follows an uncertain outcome. Clearing
    // the exact original document is best effort, not proof of draining.
    try { await source.call({ operation: 'abort' }); } catch { /* retained uncertainty */ }
  }
}
