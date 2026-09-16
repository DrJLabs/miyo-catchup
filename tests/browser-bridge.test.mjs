import assert from 'node:assert/strict';
import test from 'node:test';
import { openOwnedPage } from '../extension/browser-bridge.mjs';

const browserInstanceId = '00000000-0000-4000-8000-000000000001';
const initialize = { operation: 'initialize', binding: { principal_id: 'synthetic-user', context_id: 'synthetic-personal' },
  conversation_id: 'synthetic-conversation', qualification: { adapter_id: 'synthetic-v1' } };

function event() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => { for (const fn of listeners) fn(...args); }, listeners };
}
function fakeChrome({ initialRecord, initializeOk = true } = {}) {
  const state = initialRecord ? { t02_owned_document: initialRecord } : {};
  const calls = [];
  const api = {
    storage: { local: {
      async get() { return structuredClone(state); },
      async set(update) { Object.assign(state, structuredClone(update)); },
    } },
    tabs: { onUpdated: event(), onRemoved: event(),
      async create(options) { calls.push(['create', options]); return { id: 7 }; },
      async get() { return { id: 7, status: 'complete' }; },
      async remove() { throw new Error('must not close any tab'); },
    },
    scripting: { async executeScript(options) {
      calls.push(['script', options]);
      const command = options.args[0];
      return [{ frameId: 0, documentId: 'synthetic-document', result: typeof command === 'string'
        ? true : { ok: command.operation === 'initialize' ? initializeOk : true } }];
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
  assert.equal(state.t02_owned_document.browser_instance_id, browserInstanceId);
  await page.dispose();
  assert.equal(state.t02_owned_document.state, 'operator_cleanup_required');
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
  assert.equal(state.t02_owned_document.state, 'ownership_uncertain');
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
  await assert.rejects(openOwnedPage({ chromeApi: api, browserInstanceId, initialize }), { code: 'qualification_required' });
  assert.deepEqual(Object.keys(state.t02_owned_document).sort(),
    ['browser_instance_id', 'document_id', 'marker', 'state', 'tab_id']);
  assert.equal(state.t02_owned_document.state, 'ownership_uncertain');
});

test('AC06: a hung script call is bounded and never assumed drained or closed', async () => {
  const { api, state } = fakeChrome();
  const page = await openOwnedPage({ chromeApi: api, browserInstanceId, initialize, timeoutMs: 5 });
  api.scripting.executeScript = () => new Promise(() => {});
  await assert.rejects(page.call({ operation: 'pull', sequence: 0 }), { code: 'document_lost' });
  await page.dispose();
  assert.equal(state.t02_owned_document.state, 'ownership_uncertain');
});
