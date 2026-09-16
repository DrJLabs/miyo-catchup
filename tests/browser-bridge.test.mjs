import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectPageStartup, openOwnedPage, OWNED_DOCUMENT_KEY, STARTUP_DIAGNOSTIC_DOCUMENT_KEY } from '../extension/browser-bridge.mjs';

const browserInstanceId = '00000000-0000-4000-8000-000000000001';
const initialize = { operation: 'initialize', binding: { principal_id: 'synthetic-user', context_id: 'synthetic-personal' },
  conversation_id: 'synthetic-conversation', qualification: { adapter_id: 'synthetic-v1' } };
const setupInitialize = { operation: 'initialize', binding: { principal_id: 'setup-principal', context_id: null },
  conversation_id: 'synthetic-conversation', qualification: { adapter_id: 'chatgpt-setup-2026-09-16' } };

function event() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => { for (const fn of listeners) fn(...args); }, listeners };
}
function fakeChrome({ initialRecord, initializeOk = true, setupContextFailure = false,
  bindingOk = true, abortOk = true, createError, loadError = false, storageGetError = false, failSetAt } = {}) {
  const state = initialRecord ? { [OWNED_DOCUMENT_KEY]: initialRecord } : {};
  const calls = [];
  let setCalls = 0;
  const api = {
    storage: { local: {
      async get() { if (storageGetError) throw new Error('PRIVATE_STORAGE_SENTINEL'); return structuredClone(state); },
      async set(update) {
        setCalls += 1;
        if (failSetAt === setCalls) throw new Error('PRIVATE_STORAGE_SENTINEL');
        Object.assign(state, structuredClone(update));
      },
    } },
    tabs: { onUpdated: event(), onRemoved: event(),
      async create(options) { calls.push(['create', options]); if (createError) throw new Error('PRIVATE_TAB_SENTINEL'); return { id: 7 }; },
      async get() { if (loadError) throw new Error('PRIVATE_LOAD_SENTINEL'); return { id: 7, status: 'complete' }; },
      async remove() { throw new Error('must not close any tab'); },
    },
    scripting: { async executeScript(options) {
      calls.push(['script', options]);
      const command = options.args[0];
      let result;
      if (typeof command === 'string') result = bindingOk;
      else if (command.operation === 'initialize' && setupContextFailure) {
        result = { ok: false, error: { failure_class: 'identity_mismatch' } };
      } else result = { ok: command.operation === 'initialize' ? initializeOk
        : command.operation === 'abort' ? abortOk : true };
      return [{ frameId: 0, documentId: 'synthetic-document', result }];
    } },
  };
  return { api, calls, state };
}

test('AC01/AC06: creates one inactive tab and binds every collector call to exact document', async () => {
  const { api, calls, state } = fakeChrome();
  const page = await openOwnedPage({ chromeApi: api, browserInstanceId, initialize });
  assert.deepEqual(calls[0], ['create', { url: 'https://chatgpt.com/', active: false }]);
  await page.call({ operation: 'pull', sequence: 0 });
  const scripts = calls.filter(([kind]) => kind === 'script').map(([, options]) => options);
  assert.deepEqual(scripts[0].target, { tabId: 7, frameIds: [0] });
  assert.ok(scripts.slice(1).every((options) => options.world === 'MAIN'
    && options.target.documentIds[0] === 'synthetic-document'));
  assert.equal(state[OWNED_DOCUMENT_KEY].browser_instance_id, browserInstanceId);
  await page.dispose();
  assert.equal(state[OWNED_DOCUMENT_KEY].state, 'operator_cleanup_required');
  assert.equal(api.tabs.onUpdated.listeners.size, 0);
  assert.equal(api.tabs.onRemoved.listeners.size, 0);
});

test('AC06: navigation loses ownership without calling into or closing the new document', async () => {
  const { api, calls, state } = fakeChrome();
  const page = await openOwnedPage({ chromeApi: api, browserInstanceId, initialize });
  const before = calls.length;
  api.tabs.onUpdated.emit(7, { status: 'loading', url: 'https://chatgpt.com/c/synthetic-new' });
  await assert.rejects(page.call({ operation: 'dispatch' }), { code: 'document_lost' });
  await page.dispose();
  assert.equal(calls.length, before);
  assert.equal(state[OWNED_DOCUMENT_KEY].state, 'ownership_uncertain');
});

test('AC06: old persistent ownership or concurrent start cannot create another tab', async () => {
  const old = fakeChrome({ initialRecord: { state: 'opening' } });
  await assert.rejects(openOwnedPage({ chromeApi: old.api, browserInstanceId, initialize }), { code: 'dispatch_uncertain' });
  assert.equal(old.calls.length, 0);
  const fresh = fakeChrome();
  const first = openOwnedPage({ chromeApi: fresh.api, browserInstanceId, initialize });
  await assert.rejects(openOwnedPage({ chromeApi: fresh.api, browserInstanceId, initialize }), { code: 'busy' });
  await (await first).dispose();
  assert.equal(fresh.calls.filter(([kind]) => kind === 'create').length, 1);
});

test('AC02: rejected qualification retains bounded control evidence, never auth or bodies', async () => {
  const { api, state } = fakeChrome({ initializeOk: false });
  await assert.rejects(openOwnedPage({ chromeApi: api, browserInstanceId, initialize }), { code: 'page_initialization_failed' });
  assert.deepEqual(Object.keys(state[OWNED_DOCUMENT_KEY]).sort(),
    ['browser_instance_id', 'document_id', 'marker', 'startup_failure_code', 'state', 'tab_id']);
  assert.equal(state[OWNED_DOCUMENT_KEY].state, 'ownership_uncertain');
  assert.equal(state[OWNED_DOCUMENT_KEY].startup_failure_code, 'page_initialization_failed');
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_/);
  assert.equal(api.tabs.onUpdated.listeners.size, 0);
  assert.equal(api.tabs.onRemoved.listeners.size, 0);
});

test('AC06: a hung script call is bounded and never assumed drained or closed', async () => {
  const { api, state } = fakeChrome();
  const page = await openOwnedPage({ chromeApi: api, browserInstanceId, initialize, timeoutMs: 5 });
  api.scripting.executeScript = () => new Promise(() => {});
  await assert.rejects(page.call({ operation: 'pull', sequence: 0 }), { code: 'document_lost' });
  await page.dispose();
  assert.equal(state[OWNED_DOCUMENT_KEY].state, 'ownership_uncertain');
});

test('startup failures are phase-specific, sanitized, persisted once, and never close the tab', async () => {
  const cases = [
    { options: { createError: true }, expected: 'page_tab_failed' },
    { options: { loadError: true }, expected: 'page_load_failed' },
    { options: { bindingOk: false }, expected: 'page_binding_failed' },
    { options: { initializeOk: false }, expected: 'page_initialization_failed' },
    { options: { setupContextFailure: true }, initialize: setupInitialize, expected: 'page_context_unavailable' },
  ];
  for (const item of cases) {
    const { api, calls, state } = fakeChrome(item.options);
    await assert.rejects(openOwnedPage({ chromeApi: api, browserInstanceId, initialize: item.initialize ?? initialize }),
      { code: item.expected });
    assert.equal(state[OWNED_DOCUMENT_KEY].startup_failure_code, item.expected);
    assert.equal(state[OWNED_DOCUMENT_KEY].state, 'ownership_uncertain');
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_/);
    assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
    assert.equal(api.tabs.onUpdated.listeners.size, 0);
    assert.equal(api.tabs.onRemoved.listeners.size, 0);
  }
});

test('tab lookup throws and rejections immediately release all load listeners', async () => {
  for (const synchronous of [true, false]) {
    const { api, calls, state } = fakeChrome();
    api.tabs.get = () => {
      const error = new Error('PRIVATE_LOAD_SENTINEL');
      if (synchronous) throw error;
      return Promise.reject(error);
    };
    await assert.rejects(openOwnedPage({ chromeApi: api, browserInstanceId, initialize, timeoutMs: 50 }),
      { code: 'page_load_failed' });
    assert.equal(api.tabs.onUpdated.listeners.size, 0);
    assert.equal(api.tabs.onRemoved.listeners.size, 0);
    assert.equal(state[OWNED_DOCUMENT_KEY].state, 'ownership_uncertain');
    assert.equal(state[OWNED_DOCUMENT_KEY].startup_failure_code, 'page_load_failed');
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_/);
    assert.equal(calls.filter(([kind]) => kind === 'script').length, 0);
    await assert.rejects(openOwnedPage({ chromeApi: api, browserInstanceId, initialize }),
      { code: 'dispatch_uncertain' });
    assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  }
});

test('storage failures are bounded and do not leak or reset ownership evidence', async () => {
  const getFailure = fakeChrome({ storageGetError: true });
  await assert.rejects(openOwnedPage({ chromeApi: getFailure.api, browserInstanceId, initialize }),
    { code: 'page_storage_failed' });
  assert.deepEqual(getFailure.calls, []);
  const initialSetFailure = fakeChrome({ failSetAt: 1 });
  await assert.rejects(openOwnedPage({ chromeApi: initialSetFailure.api, browserInstanceId, initialize }),
    { code: 'page_storage_failed' });
  assert.deepEqual(initialSetFailure.state, {});
  assert.deepEqual(initialSetFailure.calls, []);

  const setFailure = fakeChrome({ failSetAt: 2 });
  await assert.rejects(openOwnedPage({ chromeApi: setFailure.api, browserInstanceId, initialize }),
    { code: 'page_storage_failed' });
  assert.equal(setFailure.state[OWNED_DOCUMENT_KEY].startup_failure_code, 'page_storage_failed');
  assert.equal(setFailure.state[OWNED_DOCUMENT_KEY].state, 'ownership_uncertain');
  assert.doesNotMatch(JSON.stringify(setFailure.state), /PRIVATE_/);
  assert.equal(setFailure.api.tabs.onUpdated.listeners.size, 0);
  assert.equal(setFailure.api.tabs.onRemoved.listeners.size, 0);
});

test('startup diagnostic uses its own record, forces startup_only initialization, and returns no page handle', async () => {
  const original = { browser_instance_id: browserInstanceId, marker: 'original-marker', state: 'operator_cleanup_required' };
  const { api, calls, state } = fakeChrome({ initialRecord: original });
  const result = await inspectPageStartup({ chromeApi: api, browserInstanceId, initialize: setupInitialize });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(state[OWNED_DOCUMENT_KEY], original);
  assert.equal(state[STARTUP_DIAGNOSTIC_DOCUMENT_KEY].state, 'operator_cleanup_required');
  const initialScripts = calls.filter(([kind]) => kind === 'script').map(([, options]) => options);
  const setupArgs = initialScripts.find((options) => options.args[0]?.operation === 'initialize').args[0];
  assert.equal(setupArgs.startup_only, true);
  assert.equal(initialScripts.filter((options) => options.args[0]?.operation === 'dispatch').length, 0);
  assert.equal(initialScripts.filter((options) => options.args[0]?.operation === 'abort').length, 1);
  await assert.rejects(inspectPageStartup({ chromeApi: api, browserInstanceId, initialize: setupInitialize }),
    { code: 'dispatch_uncertain' });
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
});

test('startup diagnostic rejects non-setup or caller-supplied startup_only initializers', async () => {
  const { api, calls } = fakeChrome();
  await assert.rejects(inspectPageStartup({ chromeApi: api, browserInstanceId, initialize }),
    { code: 'invalid_probe_configuration' });
  await assert.rejects(inspectPageStartup({ chromeApi: api, browserInstanceId,
    initialize: { ...setupInitialize, startup_only: false } }), { code: 'invalid_probe_configuration' });
  await assert.rejects(openOwnedPage({ chromeApi: api, browserInstanceId,
    initialize: { ...initialize, startup_only: true } }), { code: 'invalid_probe_configuration' });
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 0);
});

test('startup diagnostic rejects uncertain abort cleanup and preserves diagnostic evidence', async () => {
  const { api, state, calls } = fakeChrome({ abortOk: false });
  await assert.rejects(inspectPageStartup({ chromeApi: api, browserInstanceId, initialize: setupInitialize }),
    { code: 'document_lost' });
  assert.equal(state[STARTUP_DIAGNOSTIC_DOCUMENT_KEY].state, 'ownership_uncertain');
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(api.tabs.onUpdated.listeners.size, 0);
  assert.equal(api.tabs.onRemoved.listeners.size, 0);
});
