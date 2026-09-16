import assert from 'node:assert/strict';
import test from 'node:test';
import { createProbeController, CONFIG_KEY, FENCE_KEY, STATUS_KEY,
  STARTUP_DIAGNOSTIC_FENCE_KEY, BACKGROUND_SETUP_FENCE_KEY,
  BACKGROUND_SETUP_STATUS_KEY } from '../extension/probe-controller.mjs';
import { ProbeClientError } from '../extension/probe-client.mjs';
import { BACKGROUND_SETUP_ADAPTER_ID, BACKGROUND_SETUP_CONTRACT_FINGERPRINT,
  setupReviewedAdapters } from '../extension/qualification-config.mjs';

const config = {
  enabled: true, scope: 'background-setup-inspection',
  browser_instance_id: '00000000-0000-4000-8000-000000000010',
  conversation_id: 'synthetic-selected-conversation',
  binding: { principal_id: 'synthetic-expected-principal', context_id: null },
  qualification: { adapter_id: BACKGROUND_SETUP_ADAPTER_ID,
    contract_fingerprint: BACKGROUND_SETUP_CONTRACT_FINGERPRINT },
};
const oldRecords = {
  [FENCE_KEY]: { schema_version: 1, state: 'blocked', reason_code: 'qualification_required' },
  [STATUS_KEY]: { schema_version: 1, state: 'blocked', reason_code: 'qualification_required' },
  [STARTUP_DIAGNOSTIC_FENCE_KEY]: { schema_version: 1, state: 'blocked', reason_code: 'page_initialization_failed' },
  t02_owned_document: { state: 'ownership_uncertain', document_id: 'preserved-document' },
};
function fixture(initial = oldRecords) {
  const state = structuredClone(initial);
  const effects = [];
  const storage = {
    async get(keys) { return Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key))
      .map((key) => [key, structuredClone(state[key])])); },
    async set(update) { Object.assign(state, structuredClone(update)); },
  };
  const collector = { collectorInstanceId: '00000000-0000-4000-8000-000000000020',
    async call() {}, async dispose() { effects.push('dispose'); } };
  const options = { chromeApi: { runtime: { id: 'test-extension' }, extension: { inIncognitoContext: false } },
    storage, config, reviewedAdapters: setupReviewedAdapters, backgroundOnly: true,
    openPage: () => assert.fail('background setup must not open or script a tab'),
    makeBackgroundCollector: (input) => {
      assert.equal(state[BACKGROUND_SETUP_FENCE_KEY].state, 'starting');
      assert.deepEqual(input.binding, config.binding);
      effects.push('collector'); return collector;
    },
    makeNativeClient: () => {
      assert.equal(state[BACKGROUND_SETUP_FENCE_KEY].state, 'starting');
      effects.push('native'); return { request: async () => ({}), close() { effects.push('close'); } };
    },
    backgroundProbe: async (input) => {
      assert.equal(input.collector, collector);
      assert.equal(input.page, undefined);
      effects.push('probe'); return { state: 'background_setup_inspection_complete' };
    },
  };
  return { state, effects, options };
}
function originalsPreserved(state) {
  for (const [key, value] of Object.entries(oldRecords)) assert.deepEqual(state[key], value);
}

test('background setup is explicit, separately fenced, page-free and never promotes capture', async () => {
  const { state, effects, options } = fixture();
  const controller = createProbeController(options);
  const before = structuredClone(state);
  const ready = await controller.status();
  assert.equal(ready.can_inspect_background, true);
  assert.equal(ready.can_start, false);
  assert.equal(ready.can_inspect, undefined);
  assert.deepEqual(state, before);
  assert.deepEqual(effects, []);
  await controller.inspectBackgroundSession();
  assert.deepEqual(effects, []);
  const result = await controller.inspectBackgroundSession({ userGesture: true });
  assert.equal(result.state, 'background_setup_inspection_complete');
  assert.equal(result.can_inspect_background, false);
  assert.equal(result.can_start, false);
  assert.deepEqual(effects, ['collector', 'native', 'probe', 'close', 'dispose']);
  originalsPreserved(state);
  assert.doesNotMatch(JSON.stringify(state[BACKGROUND_SETUP_STATUS_KEY]), /synthetic|principal|conversation/);
  const after = structuredClone(state);
  const restart = createProbeController(options);
  assert.equal((await restart.status()).state, result.state);
  assert.equal((await restart.inspectBackgroundSession({ userGesture: true })).state, result.state);
  assert.deepEqual(state, after);
  assert.equal(effects.filter((value) => value === 'probe').length, 1);
});

test('public/storage configuration, incognito and scope relabeling cannot enable background setup', async () => {
  for (const mutate of [
    (f) => { delete f.options.config; f.state[CONFIG_KEY] = config; },
    (f) => { f.options.chromeApi.extension.inIncognitoContext = true; },
    (f) => { delete f.options.chromeApi.extension; },
    (f) => { f.options.reviewedAdapters = new Map(); },
    (f) => { f.options.config = { ...config, enabled: false }; },
    (f) => { f.options.config = { ...config, scope: 'setup-inspection' }; },
    (f) => { f.options.config = { ...config, scope: 'conversation',
      binding: { ...config.binding, context_id: 'synthetic-context' } }; },
    (f) => { f.options.backgroundOnly = false; },
  ]) {
    const f = fixture(); mutate(f);
    const controller = createProbeController(f.options);
    assert.notEqual((await controller.status()).can_inspect_background, true);
    await controller.inspectBackgroundSession({ userGesture: true });
    assert.deepEqual(f.effects, []);
    assert.equal(f.state[BACKGROUND_SETUP_FENCE_KEY], undefined);
    originalsPreserved(f.state);
  }
});

test('background fences and orphaned terminal statuses lock uncertain work without a retry', async () => {
  for (const initial of [
    { [BACKGROUND_SETUP_FENCE_KEY]: { schema_version: 1, state: 'starting', reason_code: 'none' } },
    { [BACKGROUND_SETUP_FENCE_KEY]: { schema_version: 1, state: 'uncertain', reason_code: 'dispatch_uncertain' } },
    { [BACKGROUND_SETUP_FENCE_KEY]: { schema_version: 1, state: 'ready', reason_code: 'none' } },
    { [BACKGROUND_SETUP_STATUS_KEY]: { state: 'running', reason_code: 'none' } },
    { [BACKGROUND_SETUP_STATUS_KEY]: { state: 'background_setup_inspection_complete',
      reason_code: 'background_setup_inspection_complete' } },
  ]) {
    const f = fixture({ ...oldRecords, ...initial });
    const before = structuredClone(f.state);
    const controller = createProbeController(f.options);
    assert.notEqual((await controller.status()).can_inspect_background, true);
    assert.equal((await controller.inspectBackgroundSession({ userGesture: true })).state, 'uncertain');
    assert.deepEqual(f.effects, []);
    assert.deepEqual(f.state, before);
  }
});

test('background failure is sanitized, disposed and permanently fenced', async () => {
  for (const error of [new Error('PRIVATE_ERROR_TOKEN'), new ProbeClientError('probe_failed')]) {
    const f = fixture();
    f.options.backgroundProbe = async () => { throw error; };
    const result = await createProbeController(f.options).inspectBackgroundSession({ userGesture: true });
    assert.ok(['failed', 'uncertain'].includes(result.state));
    assert.deepEqual(f.effects, ['collector', 'native', 'close', 'dispose']);
    assert.doesNotMatch(JSON.stringify(f.state), /PRIVATE_ERROR_TOKEN/);
    await createProbeController(f.options).inspectBackgroundSession({ userGesture: true });
    assert.equal(f.effects.filter((effect) => effect === 'native').length, 1);
    originalsPreserved(f.state);
  }
});

test('fence persistence failure prevents any collector or native effect', async () => {
  const f = fixture();
  f.options.storage.set = async () => { throw new Error('private disk error'); };
  assert.equal((await createProbeController(f.options).inspectBackgroundSession({ userGesture: true })).state, 'uncertain');
  assert.deepEqual(f.effects, []);
});

test('background message gate accepts only exact extension popup and explicit gesture', async () => {
  const f = fixture();
  const controller = createProbeController(f.options);
  const message = { type: 'inspect_background_session', user_gesture: true };
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
  for (const untrusted of [{}, { ...sender, tab: {} }, { ...sender, id: 'other' },
    { ...sender, url: 'https://chatgpt.com/' }]) {
    await controller.handleMessage(message, untrusted);
  }
  await controller.handleMessage({ ...message, url: 'https://example.invalid' }, sender);
  await controller.handleMessage({ type: message.type }, sender);
  assert.deepEqual(f.effects, []);
  assert.equal((await controller.handleMessage({ type: 'background_status' }, sender)).can_inspect_background, true);
  assert.deepEqual(f.effects, []);
  assert.equal((await controller.handleMessage(message, sender)).state, 'background_setup_inspection_complete');
});

test('a shared in-flight guard prevents overlap with another controller and connection checks', async () => {
  const f = fixture();
  let resolveProbe;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  f.options.backgroundProbe = () => { entered(); return new Promise((resolve) => { resolveProbe = resolve; }); };
  const first = createProbeController(f.options).inspectBackgroundSession({ userGesture: true });
  await started;
  const second = createProbeController(f.options);
  assert.equal((await second.inspectBackgroundSession({ userGesture: true })).reason_code, 'busy');
  assert.equal((await second.checkConnection({ userGesture: true })).state, 'busy');
  resolveProbe({ state: 'background_setup_inspection_complete' });
  await first;
  assert.equal(f.effects.filter((effect) => effect === 'native').length, 1);
});
