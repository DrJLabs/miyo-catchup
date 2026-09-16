import { openOwnedPage } from './browser-bridge.mjs';
import { createNativeClient, ProbeClientError, runProbe } from './probe-client.mjs';
import { checkNativeConnection, connectionResult } from './connection-check.mjs';

// T02 deliberately ships no production adapter. A reviewed adapter registry is
// supplied by the eventual qualification release; an empty registry is the
// only production default. This module never accepts endpoints, headers,
// executable code, or a caller-selected adapter implementation.
export const CONFIG_KEY = 't02_probe_config';
export const STATUS_KEY = 't02_probe_status';
export const FENCE_KEY = 't02_probe_start_fence';
export const PENDING_FAILURE_KEY = 't02_probe_pending_failure';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const STATES = new Set(['unconfigured', 'ready', 'blocked', 'starting', 'running', 'probe_complete', 'failed', 'uncertain']);
const REASONS = new Set([
  'none', 'disabled', 'configuration_required', 'qualification_required',
  'storage_unavailable', 'busy', 'probe_complete', 'probe_failed',
  'dispatch_uncertain', 'document_lost', 'native_unavailable', 'invalid_message',
]);
const IN_FLIGHT = new WeakSet();
const FENCE_STATES = new Set(['starting', 'running', 'probe_complete', 'failed', 'uncertain']);
const FAILURE_CLASSES = new Set(['network', 'timeout', 'rate_limited', 'auth_required', 'challenge', 'schema_changed', 'identity_mismatch', 'aborted']);

function invalid() { throw new ProbeClientError('invalid_probe_configuration'); }
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, required, optional = []) {
  if (!plain(value) || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
}
function string(value, pattern) { if (typeof value !== 'string' || !pattern.test(value)) invalid(); }
function boundedString(value, max = 128) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) invalid();
}
function clone(value) {
  try { return structuredClone(value); } catch { invalid(); }
}
function output(value) {
  // Status is intentionally a small, fixed code object. This cap is checked
  // before returning it to popup/background callers.
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 4096) invalid();
  return value;
}
function adapterEntry(reviewedAdapters, adapterId, fingerprint) {
  const entries = reviewedAdapters instanceof Map
    ? reviewedAdapters.get(adapterId)
    : reviewedAdapters?.[adapterId];
  if (!plain(entries)) return null;
  if (entries.reviewed !== true || entries.adapter_id !== adapterId
    || entries.contract_fingerprint !== fingerprint) return null;
  return entries;
}

function validateFence(value) {
  if (value === undefined) return null;
  exact(value, ['schema_version', 'state', 'reason_code']);
  if (value.schema_version !== 1 || !FENCE_STATES.has(value.state) || !REASONS.has(value.reason_code)) {
    throw new ProbeClientError('dispatch_uncertain');
  }
  return { schema_version: 1, state: value.state, reason_code: value.reason_code };
}

function validatePendingFailure(value) {
  exact(value, ['protocol_version', 'request_id', 'operation', 'payload', 'run_id', 'attempt_id', 'lease_generation', 'permit_id']);
  if (value.protocol_version !== 1 || value.operation !== 'request_failed') invalid();
  string(value.request_id, UUID); string(value.run_id, UUID); string(value.attempt_id, UUID);
  string(value.permit_id, UUID);
  if (!Number.isSafeInteger(value.lease_generation) || value.lease_generation < 0) invalid();
  exact(value.payload, ['failure_class'], ['http_status', 'retry_after']);
  if (!FAILURE_CLASSES.has(value.payload.failure_class)) invalid();
  if (value.payload.http_status !== undefined
    && (!Number.isSafeInteger(value.payload.http_status) || value.payload.http_status < 100 || value.payload.http_status > 599)) invalid();
  if (value.payload.retry_after !== undefined) boundedString(value.payload.retry_after, 128);
  return clone(value);
}

function validateConfig(value) {
  exact(value, ['enabled', 'browser_instance_id', 'conversation_id', 'binding', 'qualification']);
  if (typeof value.enabled !== 'boolean') invalid();
  string(value.browser_instance_id, UUID);
  string(value.conversation_id, ID);
  exact(value.binding, ['principal_id', 'context_id']);
  string(value.binding.principal_id, ID); string(value.binding.context_id, ID);
  exact(value.qualification, ['adapter_id', 'contract_fingerprint']);
  string(value.qualification.adapter_id, ID);
  string(value.qualification.contract_fingerprint, SHA);
  return clone(value);
}

function validateStatus(value) {
  if (!plain(value)) return null;
  const state = STATES.has(value.state) ? value.state : 'uncertain';
  const reason = REASONS.has(value.reason_code) ? value.reason_code : 'dispatch_uncertain';
  return { state, reason_code: reason, can_start: value.can_start === true,
    configured: value.configured === true, qualification_ready: value.qualification_ready === true };
}

function displayStatus({ state, reason_code, configured = false, qualification_ready = false }) {
  const canStart = state === 'ready';
  return output({ state, reason_code, can_start: canStart, configured, qualification_ready });
}

function errorReason(error) {
  const code = error instanceof ProbeClientError ? error.code : '';
  if (code === 'probe_failed') return ['failed', 'probe_failed'];
  if (code === 'document_lost') return ['uncertain', 'document_lost'];
  if (code === 'qualification_required') return ['blocked', 'qualification_required'];
  if (code === 'native_unavailable') return ['uncertain', 'native_unavailable'];
  return ['uncertain', 'dispatch_uncertain'];
}

/**
 * Create the explicit T02 controller. Calling create has no browser or native
 * side effects. `reviewedAdapters` defaults empty and must be a private,
 * reviewed registry supplied by a later qualification release.
 */
export function createProbeController({ chromeApi, storage = chromeApi?.storage?.local,
  config, reviewedAdapters = new Map(), openPage = openOwnedPage,
  makeNativeClient = createNativeClient, probe = runProbe,
  uuid = () => crypto.randomUUID() } = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function'
    || typeof openPage !== 'function' || typeof makeNativeClient !== 'function'
    || typeof probe !== 'function') invalid();
  let cachedStatus = displayStatus({ state: 'unconfigured', reason_code: 'configuration_required' });

  async function readValues() {
    const values = await storage.get([CONFIG_KEY, STATUS_KEY, FENCE_KEY]);
    if (!plain(values)) invalid();
    const selected = config === undefined
      ? (Object.hasOwn(values, CONFIG_KEY) ? validateConfig(values[CONFIG_KEY]) : null)
      : validateConfig(config);
    const status = validateStatus(values[STATUS_KEY]);
    const fence = validateFence(values[FENCE_KEY]);
    return { selected, status, fence };
  }

  async function saveStatus(status, { configured = false, qualificationReady = false } = {}) {
    const safe = displayStatus({ ...status, configured, qualification_ready: qualificationReady });
    await storage.set({ [STATUS_KEY]: { schema_version: 1, ...safe } });
    cachedStatus = safe;
    return safe;
  }

  async function status() {
    try {
      const { selected, status: stored, fence } = await readValues();
      if (!selected) return displayStatus({ state: 'unconfigured', reason_code: 'configuration_required' });
      const entry = adapterEntry(reviewedAdapters, selected.qualification.adapter_id,
        selected.qualification.contract_fingerprint);
      if (fence) return displayStatus({
        state: fence.state === 'probe_complete' ? 'probe_complete'
          : fence.state === 'failed' ? 'failed' : 'uncertain',
        reason_code: fence.reason_code, configured: true, qualification_ready: entry !== null });
      // A stored in-progress/terminal status without its durable fence is not
      // evidence of a clean state after service-worker restart.
      if (stored && ['starting', 'running', 'probe_complete', 'failed', 'uncertain'].includes(stored.state)) {
        return displayStatus({ state: 'uncertain', reason_code: 'dispatch_uncertain',
          configured: true, qualification_ready: entry !== null });
      }
      if (!selected.enabled) return displayStatus({ state: 'blocked', reason_code: 'disabled',
        configured: true, qualification_ready: entry !== null });
      if (!entry) return displayStatus({ state: 'blocked', reason_code: 'qualification_required',
        configured: true, qualification_ready: false });
      return displayStatus({ state: 'ready', reason_code: 'none', configured: true, qualification_ready: true });
    } catch (error) {
      return output(displayStatus({ state: 'uncertain', reason_code:
        error instanceof ProbeClientError && error.code === 'dispatch_uncertain'
          ? 'dispatch_uncertain' : 'storage_unavailable' }));
    }
  }

  async function start({ userGesture = false } = {}) {
    if (userGesture !== true) return output(displayStatus({ state: 'blocked', reason_code: 'invalid_message' }));
    if (IN_FLIGHT.has(storage)) return output(displayStatus({ state: 'uncertain', reason_code: 'busy' }));
    IN_FLIGHT.add(storage);
    let page;
    let native;
    let details;
    try {
      // Read and validate every caller-controlled value before any tab/native effect.
      try { details = await readValues(); } catch (error) {
        return output(displayStatus({ state: 'uncertain', reason_code:
          error instanceof ProbeClientError && error.code === 'dispatch_uncertain'
            ? 'dispatch_uncertain' : 'storage_unavailable' }));
      }
      const { selected, status: stored, fence } = details;
      if (!selected) {
        return await saveStatus({ state: 'unconfigured', reason_code: 'configuration_required' });
      }
      // A persisted in-progress or terminal status without its durable fence
      // is not safe to reinterpret as a fresh run after worker restart.
      if (!fence && stored && ['starting', 'running', 'probe_complete', 'failed', 'uncertain'].includes(stored.state)) {
        return output(displayStatus({ state: 'uncertain', reason_code: 'dispatch_uncertain',
          configured: true, qualification_ready: false }));
      }
      const entry = adapterEntry(reviewedAdapters, selected.qualification.adapter_id,
        selected.qualification.contract_fingerprint);
      const ready = selected.enabled && entry !== null;
      if (!ready) {
        return await saveStatus({ state: 'blocked',
          reason_code: selected.enabled ? 'qualification_required' : 'disabled' },
        { configured: true, qualificationReady: entry !== null });
      }
      if (fence) return output(displayStatus({ state: fence.state === 'probe_complete' ? 'probe_complete' : 'uncertain',
        reason_code: fence.reason_code, configured: true, qualification_ready: true }));
      const startFence = { schema_version: 1, state: 'starting', reason_code: 'none' };
      // This durable fence is intentionally never removed after an attempt.
      await storage.set({ [FENCE_KEY]: startFence });
      await saveStatus({ state: 'starting', reason_code: 'none' }, { configured: true, qualificationReady: true });
      const initialize = { operation: 'initialize', binding: selected.binding,
        conversation_id: selected.conversation_id,
        qualification: { adapter_id: selected.qualification.adapter_id } };
      page = await openPage({ chromeApi, browserInstanceId: selected.browser_instance_id, initialize, uuid });
      native = makeNativeClient(chromeApi);
      await saveStatus({ state: 'running', reason_code: 'none' }, { configured: true, qualificationReady: true });
      const result = await probe({ request: native.request, page,
        browserInstanceId: selected.browser_instance_id, binding: selected.binding,
        conversationId: selected.conversation_id,
        persistFailure: async (failure) => {
          await storage.set({ [PENDING_FAILURE_KEY]: validatePendingFailure(failure) });
        }, uuid });
      if (!plain(result) || result.state !== 'probe_complete') throw new ProbeClientError('dispatch_uncertain');
      await saveStatus({ state: 'probe_complete', reason_code: 'probe_complete' },
        { configured: true, qualificationReady: true });
      await storage.set({ [FENCE_KEY]: { ...startFence, state: 'probe_complete', reason_code: 'probe_complete' } });
      return cachedStatus;
    } catch (error) {
      const [state, reason] = errorReason(error);
      try {
        await saveStatus({ state, reason_code: reason }, { configured: true, qualificationReady: true });
        await storage.set({ [FENCE_KEY]: { schema_version: 1, state, reason_code: reason } });
      } catch { /* Preserve the original bounded control result below. */ }
      return output(displayStatus({ state, reason_code: reason, configured: true, qualification_ready: true }));
    } finally {
      try { native?.close?.(); } catch { /* no raw diagnostics */ }
      try { await page?.dispose?.(); } catch { /* ownership remains uncertain */ }
      IN_FLIGHT.delete(storage);
    }
  }

  async function checkConnection({ userGesture = false } = {}) {
    if (userGesture !== true) return connectionResult('invalid_message');
    if (IN_FLIGHT.has(storage)) return connectionResult('busy');
    IN_FLIGHT.add(storage);
    try {
      // get_status is the only native operation here. In particular, this must
      // neither create nor clear a capture fence, configure a probe, or open a page.
      return await checkNativeConnection({ chromeApi, makeNativeClient, uuid });
    } finally {
      IN_FLIGHT.delete(storage);
    }
  }

  async function handleMessage(message, sender = {}) {
    if (!plain(message) || Object.keys(message).some((key) => !['type', 'user_gesture'].includes(key))) {
      return output(displayStatus({ state: 'blocked', reason_code: 'invalid_message' }));
    }
    const expectedPopupUrl = chromeApi?.runtime?.id
      ? `chrome-extension://${chromeApi.runtime.id}/popup.html` : null;
    if (!expectedPopupUrl || sender.id !== chromeApi.runtime.id || sender.url !== expectedPopupUrl
      || Object.hasOwn(sender, 'tab')) {
      return output(displayStatus({ state: 'blocked', reason_code: 'invalid_message' }));
    }
    if (message.type === 'status') return status();
    if (message.type === 'check_connection' && Object.hasOwn(message, 'user_gesture')) {
      return checkConnection({ userGesture: message.user_gesture });
    }
    if (message.type === 'start' && Object.hasOwn(message, 'user_gesture')) {
      return start({ userGesture: message.user_gesture });
    }
    return output(displayStatus({ state: 'blocked', reason_code: 'invalid_message' }));
  }

  return { status, start, checkConnection, handleMessage };
}
