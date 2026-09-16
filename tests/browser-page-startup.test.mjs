import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  inspectPageStartupV2,
  OWNED_DOCUMENT_KEY,
  STARTUP_DIAGNOSTIC_DOCUMENT_KEY,
  STARTUP_DIAGNOSTIC_V2_DOCUMENT_KEY,
  STARTUP_DIAGNOSTIC_V2_FAILURE_CODES,
} from '../extension/browser-bridge.mjs';
import { pageCollector } from '../extension/page-collector.mjs';

const browserInstanceId = '00000000-0000-4000-8000-000000000002';
const marker = '00000000-0000-4000-8000-000000000003';
const setupInitialize = {
  operation: 'initialize',
  binding: { principal_id: 'setup-principal', context_id: null },
  conversation_id: 'setup-conversation',
  qualification: { adapter_id: 'chatgpt-setup-2026-09-16' },
};

function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => { for (const fn of listeners) fn(...args); },
    listeners,
  };
}

function serializedPage() {
  const context = vm.createContext({
    AbortController,
    TextDecoder,
    TextEncoder,
    atob,
    btoa,
    crypto: { subtle: { digest: async () => new Uint8Array(32) } },
    document: { cookie: '_account=personal' },
    fetch: async () => { throw new Error('PRIVATE_FETCH_SENTINEL'); },
    location: { origin: 'https://chatgpt.com' },
    setTimeout,
    clearTimeout,
  });
  context.window = context;
  context.top = context;
  return context;
}

function fakeChrome({ mode = 'success', initialRecords = {}, onScript } = {}) {
  const state = structuredClone(initialRecords);
  const calls = [];
  const context = serializedPage();
  let scriptCount = 0;
  const api = {
    storage: { local: {
      async get() { return structuredClone(state); },
      async set(update) { Object.assign(state, structuredClone(update)); },
    } },
    tabs: {
      onUpdated: event(),
      onRemoved: event(),
      async create(options) { calls.push(['create', options]); return { id: 17 }; },
      async get() { return { id: 17, status: 'complete' }; },
      async remove() { throw new Error('must not close a tab'); },
    },
    scripting: {
      async executeScript(options) {
        scriptCount += 1;
        calls.push(['script', options]);
        const command = options.args?.[0];
        const kind = options.func?.name;
        onScript?.({ kind, command, options, scriptCount, context });
        if (kind === 'pageCollector' && command?.operation === 'initialize') {
          if (mode === 'reject') throw new Error('PRIVATE_SCRIPT_SENTINEL');
          if (mode === 'timeout') return new Promise(() => {});
          if (mode === 'missing') return [];
          if (mode === 'envelope') return [{}];
          if (mode === 'document_changed') {
            return [{ frameId: 0, documentId: 'different-document', result: { ok: true } }];
          }
          if (mode === 'collector_rejected') {
            return [{ frameId: 0, documentId: 'synthetic-document',
              result: { ok: false, error: { failure_class: 'schema_changed' } } }];
          }
          if (mode === 'collector_closed') {
            return [{ frameId: 0, documentId: 'synthetic-document',
              result: { ok: false, error: { failure_class: 'aborted' } } }];
          }
          if (mode === 'collector_invalid') {
            return [{ frameId: 0, documentId: 'synthetic-document', result: { ok: true, extra: true } }];
          }
          if (mode === 'identity_mismatch') {
            return [{ frameId: 0, documentId: 'synthetic-document',
              result: { ok: false, error: { failure_class: 'identity_mismatch' } } }];
          }
        }
        const fn = vm.runInContext(`(${options.func.toString()})`, context);
        context.argsJson = JSON.stringify(options.args ?? []);
        const args = vm.runInContext('JSON.parse(argsJson)', context);
        const result = await fn(...args);
        return [{ frameId: 0, documentId: 'synthetic-document', result }];
      },
    },
  };
  // Make the actual collector source available to the serialized transport;
  // the bridge itself still supplies the function at each executeScript call.
  void pageCollector;
  return { api, state, calls, context };
}

async function inspect(fake, timeoutMs = 100) {
  return inspectPageStartupV2({
    chromeApi: fake.api,
    browserInstanceId,
    initialize: setupInitialize,
    uuid: () => marker,
    timeoutMs,
  });
}

test('v2 successful startup uses serialized page functions, aborts safely, and never fetches', async () => {
  const original = { state: 'ownership_uncertain', marker: 'original', private: 'PRIVATE_SENTINEL' };
  const v1 = { state: 'operator_cleanup_required', marker: 'v1-marker' };
  const fake = fakeChrome({ initialRecords: {
    [OWNED_DOCUMENT_KEY]: original,
    [STARTUP_DIAGNOSTIC_DOCUMENT_KEY]: v1,
  } });
  assert.deepEqual(await inspect(fake), { ok: true });
  assert.deepEqual(fake.state[OWNED_DOCUMENT_KEY], original);
  assert.deepEqual(fake.state[STARTUP_DIAGNOSTIC_DOCUMENT_KEY], v1);
  assert.equal(fake.state[STARTUP_DIAGNOSTIC_V2_DOCUMENT_KEY].state, 'operator_cleanup_required');
  assert.equal(fake.calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(fake.calls.filter(([kind, options]) => kind === 'script'
    && options.args?.[0]?.operation === 'dispatch').length, 0);
  assert.equal(fake.calls.filter(([kind, options]) => kind === 'script'
    && options.args?.[0]?.operation === 'abort').length, 1);
  assert.equal(fake.api.tabs.onUpdated.listeners.size, 0);
  assert.equal(fake.api.tabs.onRemoved.listeners.size, 0);
});

test('v2 exports the fixed bounded diagnostic code set', () => {
  assert.deepEqual([...STARTUP_DIAGNOSTIC_V2_FAILURE_CODES], [
    'page_script_rejected', 'page_script_timeout', 'page_document_changed',
    'page_result_invalid', 'page_result_missing', 'page_collector_rejected',
    'page_collector_closed',
  ]);
  assert.throws(() => STARTUP_DIAGNOSTIC_V2_FAILURE_CODES.push('PRIVATE_SENTINEL'), TypeError);
});

test('v2 distinguishes transport and collector outcomes without exporting raw failures', async () => {
  const cases = [
    ['reject', 'page_script_rejected'],
    ['timeout', 'page_script_timeout'],
    ['document_changed', 'page_document_changed'],
    ['envelope', 'page_result_invalid'],
    ['missing', 'page_result_missing'],
    ['collector_rejected', 'page_collector_rejected'],
    ['collector_closed', 'page_collector_closed'],
    ['collector_invalid', 'page_result_invalid'],
  ];
  for (const [mode, expected] of cases) {
    const fake = fakeChrome({ mode });
    await assert.rejects(inspect(fake, mode === 'timeout' ? 5 : 100), { code: expected });
    assert.equal(fake.state[STARTUP_DIAGNOSTIC_V2_DOCUMENT_KEY].startup_failure_code, expected);
    assert.doesNotMatch(JSON.stringify(fake.state), /PRIVATE_SCRIPT_SENTINEL|PRIVATE_FETCH_SENTINEL/);
    assert.equal(fake.api.tabs.onUpdated.listeners.size, 0);
    assert.equal(fake.api.tabs.onRemoved.listeners.size, 0);
  }
});

test('v2 keeps setup identity mismatch distinct from transport failures', async () => {
  const fake = fakeChrome({ mode: 'identity_mismatch' });
  await assert.rejects(inspect(fake), { code: 'page_context_unavailable' });
  assert.equal(fake.state[STARTUP_DIAGNOSTIC_V2_DOCUMENT_KEY].startup_failure_code,
    'page_context_unavailable');
});

test('v2 rejects non-setup or caller-controlled startup mode before opening a tab', async () => {
  const fake = fakeChrome();
  await assert.rejects(inspectPageStartupV2({ chromeApi: fake.api, browserInstanceId,
    initialize: { ...setupInitialize, startup_only: true } }), { code: 'invalid_probe_configuration' });
  await assert.rejects(inspectPageStartupV2({ chromeApi: fake.api, browserInstanceId,
    initialize: { ...setupInitialize, qualification: { adapter_id: 'synthetic-v1' } } }),
  { code: 'invalid_probe_configuration' });
  assert.equal(fake.calls.length, 0);
});

test('v2 reports an abort/cleanup collector closure and preserves uncertain evidence', async () => {
  const fake = fakeChrome({ onScript({ kind, command, options }) {
    if (kind === 'pageCollector' && command?.operation === 'abort') {
      options.args[0] = { operation: 'abort' };
    }
  } });
  // Replace only the serialized abort response after a valid initialization.
  const original = fake.api.scripting.executeScript;
  fake.api.scripting.executeScript = async (options) => {
    if (options.func?.name === 'pageCollector' && options.args?.[0]?.operation === 'abort') {
      return [{ frameId: 0, documentId: 'synthetic-document',
        result: { ok: false, error: { failure_class: 'aborted' } } }];
    }
    return original(options);
  };
  await assert.rejects(inspect(fake), { code: 'page_collector_closed' });
  assert.equal(fake.state[STARTUP_DIAGNOSTIC_V2_DOCUMENT_KEY].state, 'ownership_uncertain');
  assert.equal(fake.state[STARTUP_DIAGNOSTIC_V2_DOCUMENT_KEY].startup_failure_code,
    'page_collector_closed');
});
