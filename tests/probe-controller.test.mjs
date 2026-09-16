import assert from 'node:assert/strict';
import test from 'node:test';
import { createProbeController, CONFIG_KEY, FENCE_KEY, STATUS_KEY } from '../extension/probe-controller.mjs';
import { ProbeClientError } from '../extension/probe-client.mjs';

const browserInstanceId = '00000000-0000-4000-8000-000000000010';
const config = {
  enabled: true,
  browser_instance_id: browserInstanceId,
  conversation_id: 'selected-conversation',
  binding: { principal_id: 'selected-user', context_id: 'personal-context' },
  qualification: { adapter_id: 'reviewed-test', contract_fingerprint: 'a'.repeat(64) },
};
const reviewedAdapters = new Map([['reviewed-test', {
  reviewed: true, adapter_id: 'reviewed-test', contract_fingerprint: 'a'.repeat(64),
}]]);

function store(initial = {}) {
  const state = structuredClone(initial);
  const calls = [];
  return {
    calls,
    async get(keys) {
      calls.push(['get', keys]);
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key))
        .map((key) => [key, structuredClone(state[key])]));
    },
    async set(update) {
      calls.push(['set', update]);
      Object.assign(state, structuredClone(update));
    },
    state,
  };
}

function chrome(storage) {
  return { runtime: { id: 'test-extension' }, storage: { local: storage } };
}

function pageFactory(calls, { documentId = 'owned-document' } = {}) {
  return async (options) => {
    calls.push(['page', options]);
    return { documentId, async dispose() { calls.push(['dispose']); } };
  };
}

test('no startup work occurs until an explicit user gesture', async () => {
  const storage = store({ [CONFIG_KEY]: config });
  const calls = [];
  const controller = createProbeController({ chromeApi: chrome(storage), storage,
    reviewedAdapters, openPage: pageFactory(calls), makeNativeClient() {
      calls.push(['native']); throw new Error('must not connect');
    } });
  const status = await controller.status();
  assert.equal(status.can_start, true);
  assert.equal(calls.length, 0);
  assert.equal(storage.state[FENCE_KEY], undefined);
});

test('production default has no reviewed adapter and blocks before tab/native effects', async () => {
  const storage = store({ [CONFIG_KEY]: config });
  const calls = [];
  const controller = createProbeController({ chromeApi: chrome(storage), storage,
    openPage: pageFactory(calls), makeNativeClient() { calls.push(['native']); } });
  const status = await controller.start({ userGesture: true });
  assert.equal(status.state, 'blocked');
  assert.equal(status.reason_code, 'qualification_required');
  assert.equal(calls.length, 0);
  assert.equal(storage.state[FENCE_KEY], undefined);
});

test('racing explicit starts has one in-process flight and one persistent fence', async () => {
  const storage = store({ [CONFIG_KEY]: config });
  const calls = [];
  let releasePage;
  const openPage = async (options) => {
    calls.push(['page', options]);
    await new Promise((resolve) => { releasePage = resolve; });
    return { documentId: 'owned-document', async dispose() { calls.push(['dispose']); } };
  };
  const controller = createProbeController({ chromeApi: chrome(storage), storage,
    reviewedAdapters, openPage, makeNativeClient() {
      calls.push(['native']); return { request: async () => ({}), close() {} };
    }, probe: async () => ({ state: 'probe_complete' }) });
  const first = controller.start({ userGesture: true });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await controller.start({ userGesture: true });
  assert.equal(second.reason_code, 'busy');
  releasePage();
  const complete = await first;
  assert.equal(complete.state, 'probe_complete');
  assert.equal(calls.filter(([kind]) => kind === 'page').length, 1);
  assert.equal(storage.state[FENCE_KEY].state, 'probe_complete');
});

test('lost native port becomes bounded uncertain receipt and is not retried', async () => {
  const storage = store({ [CONFIG_KEY]: config });
  const calls = [];
  const controller = createProbeController({ chromeApi: chrome(storage), storage,
    reviewedAdapters, openPage: pageFactory(calls), makeNativeClient() {
      calls.push(['native']); return { request: async () => ({}), close() { calls.push(['close']); } };
    }, probe: async () => { throw new ProbeClientError('dispatch_uncertain'); } });
  const result = await controller.start({ userGesture: true });
  assert.deepEqual(result, { state: 'uncertain', reason_code: 'dispatch_uncertain', can_start: false,
    configured: true, qualification_ready: true });
  assert.equal(storage.state[FENCE_KEY].state, 'uncertain');
  assert.equal(calls.filter(([kind]) => kind === 'page').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'native').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'close').length, 1);
});

test('storage failure blocks before any browser or native effect', async () => {
  const calls = [];
  const storage = {
    async get() { throw new Error('storage-failure-with-private-text'); },
    async set() { throw new Error('must not set'); },
  };
  const controller = createProbeController({ chromeApi: chrome(storage), storage,
    reviewedAdapters, openPage: pageFactory(calls), makeNativeClient() {
      calls.push(['native']); throw new Error('must not connect');
    } });
  const result = await controller.start({ userGesture: true });
  assert.equal(result.reason_code, 'storage_unavailable');
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(result).includes('storage-failure'), false);
});

test('status and message outputs omit IDs/hashes and stay bounded', async () => {
  const storage = store({ [CONFIG_KEY]: config, [STATUS_KEY]: {
    schema_version: 1, state: 'probe_complete', reason_code: 'probe_complete',
    can_start: false, configured: true, qualification_ready: true,
    stage_hash: 'f'.repeat(100000), conversation_id: config.conversation_id,
  } });
  const controller = createProbeController({ chromeApi: chrome(storage), storage, reviewedAdapters });
  const status = await controller.status();
  assert.equal(JSON.stringify(status).length < 4096, true);
  assert.deepEqual(status, { state: 'uncertain', reason_code: 'dispatch_uncertain', can_start: false,
    configured: true, qualification_ready: true });
  const invalid = await controller.handleMessage({ type: 'status', stage_hash: 'f'.repeat(100000) },
    { id: 'test-extension' });
  assert.equal(invalid.reason_code, 'invalid_message');
  const wrongUrl = await controller.handleMessage({ type: 'status' },
    { id: 'test-extension', url: 'https://chatgpt.com/' });
  assert.equal(wrongUrl.reason_code, 'invalid_message');
});

test('a malformed persistent fence is uncertainty, never a reset to ready', async () => {
  const storage = store({ [CONFIG_KEY]: config, [FENCE_KEY]: {
    schema_version: 1, state: 'idle', reason_code: 'none',
  } });
  const controller = createProbeController({ chromeApi: chrome(storage), storage, reviewedAdapters });
  const status = await controller.status();
  assert.equal(status.state, 'uncertain');
  assert.equal(status.reason_code, 'dispatch_uncertain');
  const result = await controller.start({ userGesture: true });
  assert.equal(result.state, 'uncertain');
  assert.equal(result.reason_code, 'dispatch_uncertain');
});

test('a persisted terminal status without its fence blocks start before tab/native effects', async () => {
  const storage = store({ [CONFIG_KEY]: config, [STATUS_KEY]: {
    schema_version: 1, state: 'running', reason_code: 'none', can_start: false,
    configured: true, qualification_ready: true,
  } });
  const calls = [];
  const controller = createProbeController({ chromeApi: chrome(storage), storage, reviewedAdapters,
    openPage: pageFactory(calls), makeNativeClient() { calls.push(['native']); } });
  const result = await controller.start({ userGesture: true });
  assert.equal(result.state, 'uncertain');
  assert.equal(result.reason_code, 'dispatch_uncertain');
  assert.equal(calls.length, 0);
});

test('removing capture configuration cannot replay a cached completion or erase its fence', async () => {
  const storage = store({ [CONFIG_KEY]: config });
  const controller = createProbeController({ chromeApi: chrome(storage), storage, reviewedAdapters,
    openPage: pageFactory([]), makeNativeClient: () => ({ request() {}, close() {} }),
    probe: async () => ({ state: 'probe_complete' }) });
  assert.equal((await controller.start({ userGesture: true })).state, 'probe_complete');
  const fence = structuredClone(storage.state[FENCE_KEY]);
  delete storage.state[CONFIG_KEY];
  const status = await controller.status();
  assert.equal(status.state, 'unconfigured');
  assert.equal(status.can_start, false);
  assert.deepEqual(storage.state[FENCE_KEY], fence);
});
