import { pageCollector } from './page-collector.mjs';
import { ProbeClientError } from './probe-client.mjs';

export const OWNED_DOCUMENT_KEY = 't02_owned_document';
export const STARTUP_DIAGNOSTIC_DOCUMENT_KEY = 't02_startup_diagnostic_document';
export const STARTUP_DIAGNOSTIC_V2_DOCUMENT_KEY = 't02_startup_diagnostic_document_v2';
export const STARTUP_DIAGNOSTIC_V2_FAILURE_CODES = Object.freeze([
  'page_script_rejected', 'page_script_timeout', 'page_document_changed',
  'page_result_invalid', 'page_result_missing', 'page_collector_rejected',
  'page_collector_closed',
]);
const SETUP_ADAPTER_ID = 'chatgpt-setup-2026-09-16';
const STARTUP_FAILURE_CODES = new Set([
  'page_tab_failed', 'page_load_failed', 'page_binding_failed',
  'page_initialization_failed', 'page_context_unavailable', 'page_storage_failed',
]);
const STARTUP_DIAGNOSTIC_V2_CODES = new Set(STARTUP_DIAGNOSTIC_V2_FAILURE_CODES);
const OPENING = new WeakSet();

function exactSetupContextFailure(result, initialize) {
  return initialize?.qualification?.adapter_id === SETUP_ADAPTER_ID
    && result && typeof result === 'object' && !Array.isArray(result)
    && Object.keys(result).length === 2 && result.ok === false
    && result.error && typeof result.error === 'object' && !Array.isArray(result.error)
    && Object.keys(result.error).length === 1
    && result.error.failure_class === 'identity_mismatch';
}

function exactCollectorFailure(result, failureClass) {
  return result && typeof result === 'object' && !Array.isArray(result)
    && Object.keys(result).length === 2 && result.ok === false
    && result.error && typeof result.error === 'object' && !Array.isArray(result.error)
    && Object.keys(result.error).length === 1
    && result.error.failure_class === failureClass;
}

// These functions have no module closure: Chrome serializes the function.
function markDocument(marker) {
  if (location.origin !== 'https://chatgpt.com' || window !== window.top) return false;
  if (Object.hasOwn(globalThis, '__miyoT02Document')) return false;
  Object.defineProperty(globalThis, '__miyoT02Document', { value: marker });
  return true;
}
function checkDocument(marker) {
  return location.origin === 'https://chatgpt.com' && window === window.top
    && globalThis.__miyoT02Document === marker;
}

/**
 * Explicitly creates ONE inactive owned tab. No automatic startup or adoption
 * of existing tabs. Persistent ownership records block restart instead of
 * guessing whether a recycled tab number still belongs to this probe.
 * Call only after A2 authorization; tests inject a fully synthetic Chrome API.
 */
export async function openOwnedPage(options = {}) {
  if (options?.initialize && Object.hasOwn(options.initialize, 'startup_only')) {
    throw new ProbeClientError('invalid_probe_configuration');
  }
  return openOwnedPageInternal({ ...options, recordKey: OWNED_DOCUMENT_KEY, startupOnly: false });
}

async function openOwnedPageInternal({ chromeApi, browserInstanceId,
  initialize, uuid = () => crypto.randomUUID(), timeoutMs = 30000,
  recordKey, startupOnly = false, startupDiagnosticV2 = false } = {}) {
  const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!validUuid.test(browserInstanceId) || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 30000 || initialize?.operation !== 'initialize') {
    throw new ProbeClientError('invalid_probe_configuration');
  }
  if (OPENING.has(chromeApi)) throw new ProbeClientError('busy');
  OPENING.add(chromeApi);
  let previous;
  try { previous = await chromeApi.storage.local.get(recordKey); }
  catch { OPENING.delete(chromeApi); throw new ProbeClientError('page_storage_failed'); }
  if (previous === null || typeof previous !== 'object' || Array.isArray(previous)) {
    OPENING.delete(chromeApi);
    throw new ProbeClientError('page_storage_failed');
  }
  if (Object.hasOwn(previous, recordKey)) {
    OPENING.delete(chromeApi);
    throw new ProbeClientError('dispatch_uncertain');
  }
  let marker;
  try { marker = uuid(); }
  catch { OPENING.delete(chromeApi); throw new ProbeClientError('invalid_probe_configuration'); }
  if (!validUuid.test(marker)) {
    OPENING.delete(chromeApi);
    throw new ProbeClientError('invalid_probe_configuration');
  }
  let tabId;
  let documentId;
  let lost = false;
  let calling = false;
  let settled = false;
  const record = { browser_instance_id: browserInstanceId, marker, state: 'opening' };
  // An interrupted creation must not let the next process create a second tab.
  try { await chromeApi.storage.local.set({ [recordKey]: record }); }
  catch { OPENING.delete(chromeApi); throw new ProbeClientError('page_storage_failed'); }
  const updated = (id, change) => {
    if (id === tabId && documentId && (change.status === 'loading' || change.url !== undefined)) lost = true;
  };
  const removed = (id) => { if (id === tabId) lost = true; };
  chromeApi.tabs.onUpdated.addListener(updated);
  chromeApi.tabs.onRemoved.addListener(removed);
  function detach() {
    chromeApi.tabs.onUpdated.removeListener(updated);
    chromeApi.tabs.onRemoved.removeListener(removed);
  }
  async function execute(func, args, bound = true) {
    if (lost) throw new ProbeClientError('document_lost');
    let timer;
    let results;
    try {
      results = await Promise.race([
        chromeApi.scripting.executeScript({
          target: bound ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] },
          world: 'MAIN', func, args,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => { lost = true; reject(new ProbeClientError('document_unavailable')); }, timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
    if (lost || !Array.isArray(results) || results.length !== 1 || results[0].frameId !== 0
      || typeof results[0].documentId !== 'string'
      || (bound && results[0].documentId !== documentId)) throw new ProbeClientError('document_lost');
    return results[0];
  }
  async function executeV2(func, args, bound = true) {
    if (lost) throw new ProbeClientError('page_document_changed');
    let timer;
    let timedOut = false;
    let results;
    try {
      results = await Promise.race([
        Promise.resolve().then(() => chromeApi.scripting.executeScript({
          target: bound ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] },
          world: 'MAIN', func, args,
        })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            lost = true;
            reject(new ProbeClientError('page_script_timeout'));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (timedOut) throw new ProbeClientError('page_script_timeout');
      if (lost) throw new ProbeClientError('page_document_changed');
      // Deliberately discard the rejected value, which may contain page data.
      throw new ProbeClientError('page_script_rejected');
    } finally { clearTimeout(timer); }
    if (lost) throw new ProbeClientError('page_document_changed');
    if (!Array.isArray(results)) throw new ProbeClientError('page_result_invalid');
    if (results.length === 0) throw new ProbeClientError('page_result_missing');
    if (results.length !== 1 || !results[0] || typeof results[0] !== 'object'
      || Array.isArray(results[0]) || results[0].frameId !== 0
      || typeof results[0].documentId !== 'string'
      || (bound && results[0].documentId !== documentId)) {
      if (bound && results.length === 1 && results[0]
        && typeof results[0] === 'object' && !Array.isArray(results[0])
        && results[0].frameId === 0 && typeof results[0].documentId === 'string'
        && results[0].documentId !== documentId) {
        throw new ProbeClientError('page_document_changed');
      }
      throw new ProbeClientError('page_result_invalid');
    }
    if (!Object.hasOwn(results[0], 'result') || results[0].result === undefined) {
      throw new ProbeClientError('page_result_missing');
    }
    return results[0];
  }
  function validateV2Result(envelope) {
    const result = envelope.result;
    if (result && typeof result === 'object' && !Array.isArray(result)
      && Object.keys(result).length === 1 && result.ok === true) return;
    if (exactSetupContextFailure(result, initialize)) {
      throw new ProbeClientError('page_context_unavailable');
    }
    if (exactCollectorFailure(result, 'schema_changed')) {
      throw new ProbeClientError('page_collector_rejected');
    }
    if (exactCollectorFailure(result, 'aborted')) {
      throw new ProbeClientError('page_collector_closed');
    }
    throw new ProbeClientError('page_result_invalid');
  }
  let phase = 'tab';
  try {
    phase = 'tab';
    const tab = await chromeApi.tabs.create({ url: 'https://chatgpt.com/', active: false });
    if (!Number.isSafeInteger(tab.id) || tab.id < 0) throw new ProbeClientError('document_lost');
    tabId = tab.id;
    record.tab_id = tabId;
    phase = 'storage';
    await chromeApi.storage.local.set({ [recordKey]: { ...record } });
    phase = 'load';
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chromeApi.tabs.onUpdated.removeListener(ready);
        chromeApi.tabs.onRemoved.removeListener(gone);
        if (error) reject(error); else resolve();
      };
      const ready = (id, change) => { if (id === tabId && change.status === 'complete') finish(); };
      const gone = (id) => { if (id === tabId) finish(new ProbeClientError('document_lost')); };
      const timer = setTimeout(() => finish(new ProbeClientError('document_unavailable')), timeoutMs);
      chromeApi.tabs.onUpdated.addListener(ready);
      chromeApi.tabs.onRemoved.addListener(gone);
      try {
        Promise.resolve(chromeApi.tabs.get(tabId)).then((current) => {
          if (current.status === 'complete') finish();
        }, () => finish(new ProbeClientError('document_lost')));
      } catch {
        finish(new ProbeClientError('document_lost'));
      }
    });
    phase = 'binding';
    const marked = await (startupDiagnosticV2
      ? executeV2(markDocument, [marker], false) : execute(markDocument, [marker], false));
    if (marked.result !== true) throw new ProbeClientError('page_binding_failed');
    documentId = marked.documentId;
    record.document_id = documentId;
    record.state = 'owned';
    phase = 'storage';
    await chromeApi.storage.local.set({ [recordKey]: { ...record } });
    phase = 'initialization';
    const initial = await (startupDiagnosticV2
      ? executeV2(pageCollector, [startupOnly ? { ...initialize, startup_only: true } : initialize])
      : execute(pageCollector, [startupOnly ? { ...initialize, startup_only: true } : initialize]));
    if (startupDiagnosticV2) validateV2Result(initial);
    else if (initial.result?.ok !== true) {
      const code = exactSetupContextFailure(initial.result, initialize)
        ? 'page_context_unavailable' : 'page_initialization_failed';
      throw new ProbeClientError(code);
    }
    OPENING.delete(chromeApi);
    return {
      documentId,
      async call(command) {
        if (calling || settled) throw new ProbeClientError('probe_closed');
        calling = true;
        try {
          const checked = await execute(checkDocument, [marker]);
          if (checked.result !== true) { lost = true; throw new ProbeClientError('document_lost'); }
          return (await execute(pageCollector, [command])).result;
        } catch {
          lost = true;
          throw new ProbeClientError('document_lost');
        } finally { calling = false; }
      },
      async dispose() {
        if (settled) return;
        if (calling) throw new ProbeClientError('dispatch_uncertain');
        let disposeErrorCode;
        if (!lost) {
          try {
            const aborted = await (startupDiagnosticV2
              ? executeV2(pageCollector, [{ operation: 'abort' }])
              : execute(pageCollector, [{ operation: 'abort' }]));
            if (startupDiagnosticV2) validateV2Result(aborted);
            else if (aborted.result?.ok !== true) lost = true;
          } catch (error) {
            lost = true;
            if (startupDiagnosticV2 && error instanceof ProbeClientError) {
              record.startup_failure_code = error.code;
              disposeErrorCode = error.code;
            }
          }
        }
        settled = true;
        detach();
        record.state = lost ? 'ownership_uncertain' : 'operator_cleanup_required';
        await chromeApi.storage.local.set({ [recordKey]: { ...record } });
        // Deliberately no tabs.remove: Chrome cannot close atomically by
        // documentId. The operator closes this qualification tab after checking
        // it. Navigation must never cause us to close a user's new document.
        return { ok: !lost, ...(disposeErrorCode ? { error_code: disposeErrorCode } : {}) };
      },
    };
  } catch (error) {
    detach();
    record.state = 'ownership_uncertain';
    let code;
    if (phase === 'tab') code = 'page_tab_failed';
    else if (phase === 'load') code = 'page_load_failed';
    else if (phase === 'binding') code = 'page_binding_failed';
    else if (phase === 'initialization') {
      code = error instanceof ProbeClientError
        && (STARTUP_FAILURE_CODES.has(error.code) || STARTUP_DIAGNOSTIC_V2_CODES.has(error.code))
        ? error.code : 'page_initialization_failed';
    } else if (phase === 'storage') code = 'page_storage_failed';
    else code = 'page_initialization_failed';
    record.startup_failure_code = code;
    try { await chromeApi.storage.local.set({ [recordKey]: { ...record } }); }
    catch { OPENING.delete(chromeApi); throw new ProbeClientError('page_storage_failed'); }
    OPENING.delete(chromeApi);
    throw new ProbeClientError(code);
  }
}

/**
 * Create and initialize one fixed setup page, then dispose it without exposing
 * a page handle. This diagnostic owns a separate persistent record and never
 * opens a native connection or dispatches collector work.
 */
export async function inspectPageStartup(options = {}) {
  const initialize = options?.initialize;
  if (!initialize || typeof initialize !== 'object' || Array.isArray(initialize)
    || initialize.operation !== 'initialize'
    || initialize.qualification?.adapter_id !== SETUP_ADAPTER_ID
    || Object.hasOwn(initialize, 'startup_only')) {
    throw new ProbeClientError('invalid_probe_configuration');
  }
  const page = await openOwnedPageInternal({ ...options,
    initialize: { ...initialize, startup_only: true },
    recordKey: STARTUP_DIAGNOSTIC_DOCUMENT_KEY,
    startupOnly: true,
  });
  let disposed;
  try { disposed = await page.dispose(); }
  catch (error) {
    throw error instanceof ProbeClientError ? error : new ProbeClientError('page_storage_failed');
  }
  if (disposed?.ok !== true) throw new ProbeClientError('document_lost');
  return { ok: true };
}

/**
 * Finer-grained, setup-only startup inspection. This intentionally has a
 * separate record and never returns a page handle or performs collector work.
 */
export async function inspectPageStartupV2(options = {}) {
  const initialize = options?.initialize;
  if (!initialize || typeof initialize !== 'object' || Array.isArray(initialize)
    || initialize.operation !== 'initialize'
    || initialize.qualification?.adapter_id !== SETUP_ADAPTER_ID
    || Object.hasOwn(initialize, 'startup_only')) {
    throw new ProbeClientError('invalid_probe_configuration');
  }
  const page = await openOwnedPageInternal({ ...options,
    initialize: { ...initialize, startup_only: true },
    recordKey: STARTUP_DIAGNOSTIC_V2_DOCUMENT_KEY,
    startupOnly: true,
    startupDiagnosticV2: true,
  });
  let disposed;
  try { disposed = await page.dispose(); }
  catch (error) {
    throw error instanceof ProbeClientError ? error : new ProbeClientError('page_storage_failed');
  }
  if (disposed?.ok !== true) {
    throw new ProbeClientError(disposed?.error_code ?? 'page_document_changed');
  }
  return { ok: true };
}
