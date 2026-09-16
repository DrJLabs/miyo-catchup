import { openOwnedPage, OWNED_DOCUMENT_KEY, inspectPageStartup,
  STARTUP_DIAGNOSTIC_DOCUMENT_KEY, inspectPageStartupV2,
  STARTUP_DIAGNOSTIC_V2_DOCUMENT_KEY, STARTUP_DIAGNOSTIC_V2_FAILURE_CODES } from './browser-bridge.mjs';
import { createNativeClient, ProbeClientError, runProbe, runSetupInspection,
  runBackgroundSetupInspection } from './probe-client.mjs';
import { createBackgroundSetupCollector } from './background-setup-collector.mjs';
import { checkNativeConnection, connectionResult } from './connection-check.mjs';
import { SETUP_ADAPTER_ID, SETUP_CONTRACT_FINGERPRINT,
  BACKGROUND_SETUP_ADAPTER_ID, BACKGROUND_SETUP_CONTRACT_FINGERPRINT } from './qualification-config.mjs';

// T02 deliberately ships no full-capture adapter. The separate setup adapter
// requires private constructor configuration and cannot be enabled by storage.
// The controller defaults to an empty registry and never accepts endpoints, headers,
// executable code, or a caller-selected adapter implementation.
export const CONFIG_KEY = 't02_probe_config';
export const STATUS_KEY = 't02_probe_status';
export const FENCE_KEY = 't02_probe_start_fence';
export const PENDING_FAILURE_KEY = 't02_probe_pending_failure';
export const STARTUP_DIAGNOSTIC_FENCE_KEY = 't02_startup_diagnostic_fence';
export const STARTUP_DIAGNOSTIC_V2_FENCE_KEY = 't02_startup_diagnostic_fence_v2';
export const BACKGROUND_SETUP_FENCE_KEY = 't02_background_setup_start_fence';
export const BACKGROUND_SETUP_STATUS_KEY = 't02_background_setup_status';
export const BACKGROUND_SETUP_PENDING_FAILURE_KEY = 't02_background_setup_pending_failure';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const STATES = new Set(['unconfigured', 'ready', 'blocked', 'starting', 'running', 'probe_complete',
  'setup_inspection_complete', 'background_setup_inspection_complete', 'failed', 'uncertain']);
const STARTUP_FAILURES = new Set(['page_tab_failed', 'page_load_failed', 'page_binding_failed',
  'page_initialization_failed', 'page_context_unavailable', 'page_storage_failed']);
const DIAGNOSTICS = new Set([...STARTUP_FAILURES, 'legacy_before_tab_recorded',
  'legacy_before_document_binding', 'legacy_after_document_binding']);
const REASONS = new Set([
  'none', 'disabled', 'configuration_required', 'qualification_required',
  'storage_unavailable', 'busy', 'probe_complete', 'probe_failed',
  'dispatch_uncertain', 'document_lost', 'native_unavailable', 'invalid_message',
  'setup_inspection_complete', 'background_setup_inspection_complete',
  ...STARTUP_FAILURES,
]);
const IN_FLIGHT = new WeakSet();
const FENCE_STATES = new Set(['starting', 'running', 'probe_complete', 'setup_inspection_complete',
  'background_setup_inspection_complete', 'failed', 'uncertain', 'blocked']);
const FAILURE_CLASSES = new Set(['network', 'timeout', 'rate_limited', 'auth_required', 'challenge', 'schema_changed', 'identity_mismatch', 'aborted']);
const STARTUP_FENCE_REASONS = {
  starting: new Set(['none']),
  passed: new Set(['startup_complete']),
  blocked: new Set([...STARTUP_FAILURES, ...STARTUP_DIAGNOSTIC_V2_FAILURE_CODES, 'qualification_required']),
  uncertain: new Set(['dispatch_uncertain', 'document_lost', 'storage_unavailable']),
};

function startupResult(state, reason_code, revision) {
  return output({ type: 'startup_diagnostic', state, reason_code, can_run: state === 'ready',
    ...(revision === 2 ? { revision: 2 } : {}) });
}

function validateStartupFence(value) {
  if (value === undefined) return null;
  exact(value, ['schema_version', 'state', 'reason_code']);
  if (value.schema_version !== 1 || !Object.hasOwn(STARTUP_FENCE_REASONS, value.state)
    || !STARTUP_FENCE_REASONS[value.state].has(value.reason_code)) {
    throw new ProbeClientError('dispatch_uncertain');
  }
  return { schema_version: 1, state: value.state, reason_code: value.reason_code };
}

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

function adapterReady(reviewedAdapters, selected) {
  const entry = adapterEntry(reviewedAdapters, selected.qualification.adapter_id,
    selected.qualification.contract_fingerprint);
  if (!entry) return null;
  if (selected.scope === 'background-setup-inspection') {
    return selected.qualification.adapter_id === BACKGROUND_SETUP_ADAPTER_ID
      && selected.qualification.contract_fingerprint === BACKGROUND_SETUP_CONTRACT_FINGERPRINT
      && entry.scope === 'background-setup-inspection' ? entry : null;
  }
  if (selected.scope === 'setup-inspection') {
    return selected.qualification.adapter_id === SETUP_ADAPTER_ID
      && selected.qualification.contract_fingerprint === SETUP_CONTRACT_FINGERPRINT
      && entry.scope === 'setup-inspection' ? entry : null;
  }
  // The setup adapter is never a body-capture adapter, even if a malicious
  // registry tries to relabel it.
  if ([SETUP_ADAPTER_ID, BACKGROUND_SETUP_ADAPTER_ID].includes(selected.qualification.adapter_id)) return null;
  return entry;
}

function validateFence(value) {
  if (value === undefined) return null;
  exact(value, ['schema_version', 'state', 'reason_code']);
  if (value.schema_version !== 1 || !FENCE_STATES.has(value.state) || !REASONS.has(value.reason_code)) {
    throw new ProbeClientError('dispatch_uncertain');
  }
  return { schema_version: 1, state: value.state, reason_code: value.reason_code };
}

function startupDiagnostic(fence, record, selected) {
  if (fence.state !== 'blocked') return undefined;
  if (STARTUP_FAILURES.has(fence.reason_code)) return fence.reason_code;
  if (fence.reason_code !== 'qualification_required' || !plain(record)
    || record.state !== 'ownership_uncertain'
    || record.browser_instance_id !== selected.browser_instance_id
    || typeof record.marker !== 'string' || !UUID.test(record.marker)) return undefined;
  if (Object.hasOwn(record, 'startup_failure_code')) {
    return STARTUP_FAILURES.has(record.startup_failure_code) ? record.startup_failure_code : undefined;
  }
  // Old builds discarded the original error. Report only the last saved
  // milestone, never infer a cookie, permission or authentication failure.
  if (!Object.hasOwn(record, 'tab_id')) {
    return Object.hasOwn(record, 'document_id') ? undefined : 'legacy_before_tab_recorded';
  }
  if (!Number.isSafeInteger(record.tab_id) || record.tab_id < 0) return undefined;
  if (!Object.hasOwn(record, 'document_id')) return 'legacy_before_document_binding';
  return typeof record.document_id === 'string' && ID.test(record.document_id)
    ? 'legacy_after_document_binding' : undefined;
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
  exact(value, ['enabled', 'browser_instance_id', 'conversation_id', 'binding', 'qualification'], ['scope']);
  if (typeof value.enabled !== 'boolean') invalid();
  string(value.browser_instance_id, UUID);
  string(value.conversation_id, ID);
  exact(value.binding, ['principal_id', 'context_id']);
  string(value.binding.principal_id, ID);
  const scope = value.scope === undefined ? 'conversation' : value.scope;
  if (!['conversation', 'setup-inspection', 'background-setup-inspection'].includes(scope)) invalid();
  if (scope !== 'conversation') {
    if (value.binding.context_id !== null) invalid();
  } else string(value.binding.context_id, ID);
  exact(value.qualification, ['adapter_id', 'contract_fingerprint']);
  string(value.qualification.adapter_id, ID);
  string(value.qualification.contract_fingerprint, SHA);
  return { ...clone(value), scope };
}

function validateStatus(value) {
  if (!plain(value)) return null;
  const state = STATES.has(value.state) ? value.state : 'uncertain';
  const reason = REASONS.has(value.reason_code) ? value.reason_code : 'dispatch_uncertain';
  const status = { state, reason_code: reason, can_start: value.can_start === true,
    configured: value.configured === true, qualification_ready: value.qualification_ready === true };
  if (value.scope === 'setup-inspection') status.scope = value.scope;
  if (value.scope === 'background-setup-inspection') status.scope = value.scope;
  if (value.can_inspect === true) status.can_inspect = true;
  if (value.can_inspect_background === true) status.can_inspect_background = true;
  return status;
}

function displayStatus({ state, reason_code, scope = 'conversation', configured = false,
  qualification_ready = false, diagnostic_code }) {
  const setup = ['setup-inspection', 'background-setup-inspection'].includes(scope);
  const canStart = state === 'ready' && !setup;
  const status = { state, reason_code, can_start: canStart, configured, qualification_ready };
  if (setup) {
    status.scope = scope;
    status[scope === 'background-setup-inspection' ? 'can_inspect_background' : 'can_inspect'] = state === 'ready';
  }
  if (DIAGNOSTICS.has(diagnostic_code)) status.diagnostic_code = diagnostic_code;
  return output(status);
}

function errorReason(error) {
  const code = error instanceof ProbeClientError ? error.code : '';
  if (STARTUP_FAILURES.has(code)) return ['blocked', code];
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
  setupProbe = runSetupInspection,
  startupDiagnosticEnabled = false, inspectStartup = inspectPageStartup,
  startupDiagnosticRevision = 1, inspectStartupV2 = inspectPageStartupV2,
  backgroundOnly = false, makeBackgroundCollector = createBackgroundSetupCollector,
  backgroundProbe = runBackgroundSetupInspection,
  uuid = () => crypto.randomUUID() } = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function'
    || typeof openPage !== 'function' || typeof makeNativeClient !== 'function'
    || typeof probe !== 'function' || typeof setupProbe !== 'function'
    || typeof inspectStartup !== 'function' || typeof inspectStartupV2 !== 'function'
    || typeof startupDiagnosticEnabled !== 'boolean' || ![1, 2].includes(startupDiagnosticRevision)
    || typeof backgroundOnly !== 'boolean' || typeof makeBackgroundCollector !== 'function'
    || typeof backgroundProbe !== 'function') invalid();
  let cachedStatus = displayStatus({ state: 'unconfigured', reason_code: 'configuration_required' });
  const diagnosticResult = (state, reason) => startupResult(state, reason, startupDiagnosticRevision);
  // Revision selection is private package configuration, never a popup/storage
  // input or arbitrary record name. Neither revision can clear the other's lock.
  const diagnosticFenceKey = startupDiagnosticRevision === 2
    ? STARTUP_DIAGNOSTIC_V2_FENCE_KEY : STARTUP_DIAGNOSTIC_FENCE_KEY;
  const diagnosticDocumentKey = startupDiagnosticRevision === 2
    ? STARTUP_DIAGNOSTIC_V2_DOCUMENT_KEY : STARTUP_DIAGNOSTIC_DOCUMENT_KEY;
  const fenceKey = backgroundOnly ? BACKGROUND_SETUP_FENCE_KEY : FENCE_KEY;
  const statusKey = backgroundOnly ? BACKGROUND_SETUP_STATUS_KEY : STATUS_KEY;
  const pendingFailureKey = backgroundOnly ? BACKGROUND_SETUP_PENDING_FAILURE_KEY : PENDING_FAILURE_KEY;
  const defaultScope = backgroundOnly ? 'background-setup-inspection' : 'conversation';

  async function readValues() {
    const values = await storage.get([...(backgroundOnly ? [] : [CONFIG_KEY, OWNED_DOCUMENT_KEY]), statusKey, fenceKey]);
    if (!plain(values)) invalid();
    const selected = config === undefined
      ? (!backgroundOnly && Object.hasOwn(values, CONFIG_KEY) ? validateConfig(values[CONFIG_KEY]) : null)
      : validateConfig(config);
    const status = validateStatus(values[statusKey]);
    const fence = validateFence(values[fenceKey]);
    return { selected, status, fence, ownedRecord: values[OWNED_DOCUMENT_KEY] };
  }

  function configuredAdapter(selected) {
    if (backgroundOnly !== (selected.scope === 'background-setup-inspection')) return null;
    if (backgroundOnly && (config === undefined || chromeApi?.extension?.inIncognitoContext !== false)) return null;
    // Setup inspection is enabled only by the private package's explicit
    // setupConfig replacement. A storage-injected setup object must not turn
    // the public package into an inspection-capable build.
    if (selected.scope === 'setup-inspection' && config === undefined) return null;
    return adapterReady(reviewedAdapters, selected);
  }

  async function saveStatus(status, { scope = defaultScope, configured = false,
    qualificationReady = false } = {}) {
    const safe = displayStatus({ ...status, scope, configured, qualification_ready: qualificationReady });
    await storage.set({ [statusKey]: { schema_version: 1, ...safe } });
    cachedStatus = safe;
    return safe;
  }

  async function status() {
    try {
      const { selected, status: stored, fence, ownedRecord } = await readValues();
      if (!selected) return displayStatus({ state: 'unconfigured', reason_code: 'configuration_required', scope: defaultScope });
      const entry = configuredAdapter(selected);
      if (fence) return displayStatus({
        state: ['starting', 'running'].includes(fence.state) ? 'uncertain' : fence.state,
        reason_code: fence.reason_code, scope: selected.scope,
        diagnostic_code: startupDiagnostic(fence, ownedRecord, selected),
        configured: true, qualification_ready: entry !== null });
      // A stored in-progress/terminal status without its durable fence is not
      // evidence of a clean state after service-worker restart.
      if (stored && ['starting', 'running', 'probe_complete', 'setup_inspection_complete',
        'background_setup_inspection_complete', 'failed', 'uncertain'].includes(stored.state)) {
        return displayStatus({ state: 'uncertain', reason_code: 'dispatch_uncertain',
          scope: selected.scope, configured: true, qualification_ready: entry !== null });
      }
      if (!selected.enabled) return displayStatus({ state: 'blocked', reason_code: 'disabled',
        scope: selected.scope, configured: true, qualification_ready: entry !== null });
      if (!entry) return displayStatus({ state: 'blocked', reason_code: 'qualification_required',
        scope: selected.scope, configured: true, qualification_ready: false });
      return displayStatus({ state: 'ready', reason_code: 'none', scope: selected.scope,
        configured: true, qualification_ready: true });
    } catch (error) {
      return output(displayStatus({ state: 'uncertain', reason_code:
        error instanceof ProbeClientError && error.code === 'dispatch_uncertain'
          ? 'dispatch_uncertain' : 'storage_unavailable' }));
    }
  }

  async function run(mode, { userGesture = false } = {}) {
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
      const { selected, status: stored, fence, ownedRecord } = details;
      if (!selected) {
        return await saveStatus({ state: 'unconfigured', reason_code: 'configuration_required' });
      }
      if (selected.scope !== mode
        || backgroundOnly !== (selected.scope === 'background-setup-inspection')) {
        return output(displayStatus({ state: 'blocked', reason_code: 'invalid_message', scope: selected.scope,
          configured: true, qualification_ready: false }));
      }
      // A persisted in-progress or terminal status without its durable fence
      // is not safe to reinterpret as a fresh run after worker restart.
      if (!fence && stored && ['starting', 'running', 'probe_complete', 'setup_inspection_complete',
        'background_setup_inspection_complete', 'failed', 'uncertain'].includes(stored.state)) {
        return output(displayStatus({ state: 'uncertain', reason_code: 'dispatch_uncertain',
          scope: selected.scope, configured: true, qualification_ready: false }));
      }
      const entry = configuredAdapter(selected);
      const ready = selected.enabled && entry !== null;
      if (!ready) {
        return await saveStatus({ state: 'blocked',
          reason_code: selected.enabled ? 'qualification_required' : 'disabled' },
        { scope: selected.scope, configured: true, qualificationReady: entry !== null });
      }
      if (fence) return output(displayStatus({
        state: ['starting', 'running'].includes(fence.state) ? 'uncertain' : fence.state,
        reason_code: fence.reason_code, scope: selected.scope,
        diagnostic_code: startupDiagnostic(fence, ownedRecord, selected),
        configured: true, qualification_ready: true }));
      const startFence = { schema_version: 1, state: 'starting', reason_code: 'none' };
      // This durable fence is intentionally never removed after an attempt.
      await storage.set({ [fenceKey]: startFence });
      await saveStatus({ state: 'starting', reason_code: 'none' },
        { scope: selected.scope, configured: true, qualificationReady: true });
      const initialize = { operation: 'initialize', binding: selected.binding,
        conversation_id: selected.conversation_id,
        qualification: { adapter_id: selected.qualification.adapter_id } };
      page = backgroundOnly
        ? await makeBackgroundCollector({ binding: selected.binding, uuid })
        : await openPage({ chromeApi, browserInstanceId: selected.browser_instance_id, initialize, uuid });
      native = makeNativeClient(chromeApi);
      await saveStatus({ state: 'running', reason_code: 'none' },
        { scope: selected.scope, configured: true, qualificationReady: true });
      const probeFn = backgroundOnly ? backgroundProbe : mode === 'setup-inspection' ? setupProbe : probe;
      const result = await probeFn({ request: native.request, ...(backgroundOnly ? { collector: page } : { page }),
        browserInstanceId: selected.browser_instance_id, binding: selected.binding,
        conversationId: selected.conversation_id,
        persistFailure: async (failure) => {
          await storage.set({ [pendingFailureKey]: validatePendingFailure(failure) });
        }, uuid });
      const completeState = backgroundOnly ? 'background_setup_inspection_complete'
        : mode === 'setup-inspection' ? 'setup_inspection_complete' : 'probe_complete';
      if (!plain(result) || result.state !== completeState) throw new ProbeClientError('dispatch_uncertain');
      await saveStatus({ state: completeState, reason_code: completeState },
        { scope: selected.scope, configured: true, qualificationReady: true });
      await storage.set({ [fenceKey]: { ...startFence, state: completeState, reason_code: completeState } });
      return cachedStatus;
    } catch (error) {
      const [state, reason] = errorReason(error);
      try {
        const scope = details?.selected?.scope ?? defaultScope;
        await saveStatus({ state, reason_code: reason }, { scope, configured: true, qualificationReady: true });
        await storage.set({ [fenceKey]: { schema_version: 1, state, reason_code: reason } });
      } catch { /* Preserve the original bounded control result below. */ }
      return output(displayStatus({ state, reason_code: reason,
        scope: details?.selected?.scope ?? defaultScope, configured: true, qualification_ready: true }));
    } finally {
      try { native?.close?.(); } catch { /* no raw diagnostics */ }
      try { await page?.dispose?.(); } catch { /* ownership remains uncertain */ }
      IN_FLIGHT.delete(storage);
    }
  }

  async function start(options = {}) { return run('conversation', options); }
  async function inspectSession(options = {}) { return run('setup-inspection', options); }
  async function inspectBackgroundSession(options = {}) { return run('background-setup-inspection', options); }

  async function startupReadiness() {
    // Only a private constructor flag can enable this separate one-shot action.
    // It cannot recover, modify, or replace the original attempt's fence.
    if (!startupDiagnosticEnabled || backgroundOnly) return { result: diagnosticResult('disabled', 'diagnostic_disabled') };
    try {
      const values = await storage.get([...new Set([
        diagnosticFenceKey, diagnosticDocumentKey, STARTUP_DIAGNOSTIC_FENCE_KEY,
      ])]);
      if (!plain(values)) invalid();
      const diagnosticFence = validateStartupFence(values[diagnosticFenceKey]);
      if (diagnosticFence) {
        return { result: diagnosticFence.state === 'starting'
          ? diagnosticResult('uncertain', 'dispatch_uncertain')
          : diagnosticResult(diagnosticFence.state, diagnosticFence.reason_code) };
      }
      // An orphaned diagnostic document is evidence of an earlier attempt,
      // never permission to create a replacement document.
      if (Object.hasOwn(values, diagnosticDocumentKey)) {
        return { result: diagnosticResult('uncertain', 'dispatch_uncertain') };
      }
      const { selected, fence } = await readValues();
      if (config === undefined || !selected || !selected.enabled || selected.scope !== 'setup-inspection') {
        return { result: diagnosticResult('blocked', 'configuration_required') };
      }
      if (!configuredAdapter(selected)) return { result: diagnosticResult('blocked', 'qualification_required') };
      if (!fence || !['blocked', 'failed', 'uncertain'].includes(fence.state)) {
        return { result: diagnosticResult('blocked', 'prior_attempt_required') };
      }
      const failedAttempt = (fence.state === 'blocked'
          && (STARTUP_FAILURES.has(fence.reason_code) || fence.reason_code === 'qualification_required'))
        || (fence.state === 'failed' && fence.reason_code === 'probe_failed')
        || (fence.state === 'uncertain'
          && ['dispatch_uncertain', 'document_lost', 'native_unavailable'].includes(fence.reason_code));
      if (!failedAttempt) return { result: diagnosticResult('uncertain', 'dispatch_uncertain') };
      if (startupDiagnosticRevision === 2) {
        const previous = validateStartupFence(values[STARTUP_DIAGNOSTIC_FENCE_KEY]);
        // The additional diagnostic was approved for this precise unresolved
        // result, not as a general retry mechanism for other terminal states.
        if (!previous || previous.state !== 'blocked' || previous.reason_code !== 'page_initialization_failed') {
          return { result: diagnosticResult('blocked', 'prior_diagnostic_required') };
        }
      }
      return { result: diagnosticResult('ready', 'none'), selected };
    } catch (error) {
      return { result: diagnosticResult('uncertain', error instanceof ProbeClientError
        ? 'dispatch_uncertain' : 'storage_unavailable') };
    }
  }

  async function startupStatus() {
    if (startupDiagnosticEnabled && IN_FLIGHT.has(storage)) return diagnosticResult('running', 'busy');
    return (await startupReadiness()).result;
  }

  async function diagnoseStartup({ userGesture = false } = {}) {
    if (userGesture !== true) return diagnosticResult('blocked', 'invalid_message');
    if (IN_FLIGHT.has(storage)) return diagnosticResult('running', 'busy');
    IN_FLIGHT.add(storage);
    try {
      const { result, selected } = await startupReadiness();
      if (!result.can_run) return result;
      // This fence is written before any page effect and is never cleared.
      try {
        await storage.set({ [diagnosticFenceKey]: {
          schema_version: 1, state: 'starting', reason_code: 'none',
        } });
      } catch { return diagnosticResult('uncertain', 'storage_unavailable'); }
      let terminal;
      try {
        const inspect = startupDiagnosticRevision === 2 ? inspectStartupV2 : inspectStartup;
        const outcome = await inspect({ chromeApi, browserInstanceId: selected.browser_instance_id,
          initialize: { operation: 'initialize', binding: selected.binding,
            conversation_id: selected.conversation_id,
            qualification: { adapter_id: selected.qualification.adapter_id } }, uuid });
        if (!plain(outcome) || Object.keys(outcome).length !== 1 || outcome.ok !== true) {
          throw new ProbeClientError('dispatch_uncertain');
        }
        terminal = diagnosticResult('passed', 'startup_complete');
      } catch (error) {
        const code = error instanceof ProbeClientError ? error.code : '';
        terminal = STARTUP_FAILURES.has(code) || code === 'qualification_required'
          || (startupDiagnosticRevision === 2 && STARTUP_DIAGNOSTIC_V2_FAILURE_CODES.includes(code))
          ? diagnosticResult('blocked', code)
          : diagnosticResult('uncertain', code === 'document_lost' ? 'document_lost' : 'dispatch_uncertain');
      }
      try {
        await storage.set({ [diagnosticFenceKey]: {
          schema_version: 1, state: terminal.state, reason_code: terminal.reason_code,
        } });
      } catch { return diagnosticResult('uncertain', 'storage_unavailable'); }
      return terminal;
    } finally { IN_FLIGHT.delete(storage); }
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
    if (message.type === 'background_status' && backgroundOnly) return status();
    if (message.type === 'inspect_background_session' && backgroundOnly && Object.hasOwn(message, 'user_gesture')) {
      return inspectBackgroundSession({ userGesture: message.user_gesture });
    }
    if (message.type === 'startup_status') return startupStatus();
    if (message.type === 'diagnose_startup' && Object.hasOwn(message, 'user_gesture')) {
      return diagnoseStartup({ userGesture: message.user_gesture });
    }
    if (message.type === 'check_connection' && Object.hasOwn(message, 'user_gesture')) {
      return checkConnection({ userGesture: message.user_gesture });
    }
    if (message.type === 'start' && Object.hasOwn(message, 'user_gesture')) {
      return start({ userGesture: message.user_gesture });
    }
    if (message.type === 'inspect_session' && Object.hasOwn(message, 'user_gesture')) {
      return inspectSession({ userGesture: message.user_gesture });
    }
    return output(displayStatus({ state: 'blocked', reason_code: 'invalid_message' }));
  }

  return { status, start, inspectSession, inspectBackgroundSession, checkConnection,
    startupStatus, diagnoseStartup, handleMessage };
}
