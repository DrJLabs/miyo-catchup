import assert from 'node:assert/strict';
import test from 'node:test';
import { createProbeController, CONFIG_KEY, FENCE_KEY, STATUS_KEY, PENDING_FAILURE_KEY,
  STARTUP_DIAGNOSTIC_FENCE_KEY, STARTUP_DIAGNOSTIC_V2_FENCE_KEY,
  BACKGROUND_SETUP_FENCE_KEY, BACKGROUND_SETUP_STATUS_KEY, BACKGROUND_SETUP_PENDING_FAILURE_KEY,
  BACKGROUND_SELECTED_FENCE_KEY, BACKGROUND_SELECTED_STATUS_KEY,
  BACKGROUND_SELECTED_PENDING_FAILURE_KEY } from '../extension/probe-controller.mjs';
import { ProbeClientError } from '../extension/probe-client.mjs';
import { BACKGROUND_SELECTED_ADAPTER_ID, BACKGROUND_SELECTED_CONTRACT_FINGERPRINT,
  backgroundSelectedConfig, backgroundSelectedReviewedAdapters } from '../extension/qualification-config.mjs';
import { installBackground } from '../extension/background.mjs';

const config = {
  enabled: true, scope: 'background-selected-conversation',
  browser_instance_id: '00000000-0000-4000-8000-000000000010',
  conversation_id: 'synthetic-selected-conversation',
  binding: { principal_id: 'synthetic-expected-principal', context_id: 'synthetic-personal-context' },
  qualification: { adapter_id: BACKGROUND_SELECTED_ADAPTER_ID,
    contract_fingerprint: BACKGROUND_SELECTED_CONTRACT_FINGERPRINT },
};
const oldRecords = {
  [FENCE_KEY]: { schema_version: 1, state: 'blocked', reason_code: 'qualification_required' },
  [STATUS_KEY]: { schema_version: 1, state: 'blocked', reason_code: 'qualification_required' },
  [PENDING_FAILURE_KEY]: { old: 'preserved' },
  [STARTUP_DIAGNOSTIC_FENCE_KEY]: { schema_version: 1, state: 'blocked', reason_code: 'page_initialization_failed' },
  [STARTUP_DIAGNOSTIC_V2_FENCE_KEY]: { schema_version: 1, state: 'blocked', reason_code: 'page_collector_rejected' },
  [BACKGROUND_SETUP_FENCE_KEY]: { schema_version: 1, state: 'background_setup_inspection_complete',
    reason_code: 'background_setup_inspection_complete' },
  [BACKGROUND_SETUP_STATUS_KEY]: { schema_version: 1, state: 'background_setup_inspection_complete',
    reason_code: 'background_setup_inspection_complete' },
  [BACKGROUND_SETUP_PENDING_FAILURE_KEY]: { old: 'preserved' },
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
    storage, config, reviewedAdapters: backgroundSelectedReviewedAdapters, selectedOnly: true,
    openPage: () => assert.fail('selected background action must not open or script a tab'),
    makeBackgroundCollector: () => assert.fail('selected action must not use the setup collector'),
    makeSelectedCollector: (input) => {
      assert.equal(state[BACKGROUND_SELECTED_FENCE_KEY].state, 'starting');
      assert.deepEqual(input.binding, config.binding);
      assert.equal(input.conversationId, config.conversation_id);
      effects.push('collector'); return collector;
    },
    makeNativeClient: () => {
      assert.equal(state[BACKGROUND_SELECTED_FENCE_KEY].state, 'starting');
      effects.push('native'); return { request: async () => ({}), close() { effects.push('close'); } };
    },
    runSelectedProbe: async (input) => {
      assert.equal(input.collector, collector);
      assert.equal(input.page, undefined);
      assert.deepEqual(input.binding, config.binding);
      assert.equal(input.conversationId, config.conversation_id);
      effects.push('probe'); return { state: 'background_probe_complete' };
    },
  };
  return { state, effects, options };
}
function originalsPreserved(state) {
  for (const [key, value] of Object.entries(oldRecords)) assert.deepEqual(state[key], value);
}

test('selected action is separately configured and permanently fenced without page or setup effects', async () => {
  const f = fixture();
  const controller = createProbeController(f.options);
  const before = structuredClone(f.state);
  const ready = await controller.status();
  assert.equal(ready.can_fetch_selected, true);
  assert.equal(ready.can_start, false);
  assert.equal(ready.can_inspect_background, undefined);
  assert.deepEqual(f.state, before);
  assert.deepEqual(f.effects, []);
  await controller.fetchSelectedConversation();
  await controller.start({ userGesture: true });
  await controller.inspectBackgroundSession({ userGesture: true });
  assert.deepEqual(f.effects, []);
  const result = await controller.fetchSelectedConversation({ userGesture: true });
  assert.equal(result.state, 'background_probe_complete');
  assert.equal(result.can_fetch_selected, false);
  assert.equal(result.can_start, false);
  assert.deepEqual(f.effects, ['collector', 'native', 'probe', 'close', 'dispose']);
  originalsPreserved(f.state);
  assert.doesNotMatch(JSON.stringify(f.state[BACKGROUND_SELECTED_STATUS_KEY]), /synthetic|principal|context_id/);
  const after = structuredClone(f.state);
  const restart = createProbeController(f.options);
  assert.equal((await restart.status()).state, result.state);
  assert.equal((await restart.fetchSelectedConversation({ userGesture: true })).state, result.state);
  assert.deepEqual(f.state, after);
  assert.equal(f.effects.filter((value) => value === 'probe').length, 1);
});

test('selected public defaults, storage injection, incognito, unknown contracts and bad bindings fail closed', async () => {
  assert.equal(backgroundSelectedConfig, undefined);
  for (const mutate of [
    (f) => { delete f.options.config; f.state[CONFIG_KEY] = config; },
    (f) => { f.options.chromeApi.extension.inIncognitoContext = true; },
    (f) => { delete f.options.chromeApi.extension; },
    (f) => { f.options.reviewedAdapters = new Map(); },
    (f) => { f.options.config = { ...config, enabled: false }; },
    (f) => { f.options.config = { ...config, scope: 'conversation' }; },
    (f) => { f.options.config = { ...config, scope: 'unknown' }; },
    (f) => { f.options.config = { ...config, binding: { ...config.binding, context_id: null } }; },
    (f) => { f.options.config = { ...config, binding: { ...config.binding, principal_id: '' } }; },
    (f) => { f.options.config = { ...config, conversation_id: 'https://example.invalid/' }; },
    (f) => { f.options.config = { ...config, qualification: { ...config.qualification, contract_fingerprint: 'a'.repeat(64) } }; },
    (f) => { f.options.reviewedAdapters = new Map([[BACKGROUND_SELECTED_ADAPTER_ID, {
      ...backgroundSelectedReviewedAdapters.get(BACKGROUND_SELECTED_ADAPTER_ID), scope: 'background-setup-inspection',
    }]]); },
    (f) => { f.options.selectedOnly = false; },
  ]) {
    const f = fixture(); mutate(f);
    const controller = createProbeController(f.options);
    assert.notEqual((await controller.status()).can_fetch_selected, true);
    await controller.fetchSelectedConversation({ userGesture: true });
    assert.deepEqual(f.effects, []);
    assert.equal(f.state[BACKGROUND_SELECTED_FENCE_KEY], undefined);
    originalsPreserved(f.state);
  }
  assert.throws(() => createProbeController({ ...fixture().options, backgroundOnly: true }), ProbeClientError);
});

test('selected malformed fences, orphaned status and failure evidence cannot be replayed', async () => {
  for (const initial of [
    { [BACKGROUND_SELECTED_FENCE_KEY]: { schema_version: 1, state: 'starting', reason_code: 'none' } },
    { [BACKGROUND_SELECTED_FENCE_KEY]: { schema_version: 1, state: 'uncertain', reason_code: 'dispatch_uncertain' } },
    { [BACKGROUND_SELECTED_FENCE_KEY]: { schema_version: 1, state: 'ready', reason_code: 'none' } },
    { [BACKGROUND_SELECTED_FENCE_KEY]: { schema_version: 2, state: 'starting', reason_code: 'none' } },
    { [BACKGROUND_SELECTED_STATUS_KEY]: { state: 'running', reason_code: 'none' } },
    { [BACKGROUND_SELECTED_STATUS_KEY]: { state: 'background_probe_complete', reason_code: 'background_probe_complete' } },
    { [BACKGROUND_SELECTED_STATUS_KEY]: null },
    { [BACKGROUND_SELECTED_STATUS_KEY]: { state: 'unknown' } },
    { [BACKGROUND_SELECTED_PENDING_FAILURE_KEY]: {} },
  ]) {
    const f = fixture({ ...oldRecords, ...initial });
    const before = structuredClone(f.state);
    const controller = createProbeController(f.options);
    assert.notEqual((await controller.status()).can_fetch_selected, true);
    assert.equal((await controller.fetchSelectedConversation({ userGesture: true })).state, 'uncertain');
    assert.deepEqual(f.effects, []);
    assert.deepEqual(f.state, before);
  }
});

test('selected failure is sanitized and fenced across restart, including a wrong completion scope', async () => {
  for (const callback of [
    async () => { throw new Error('PRIVATE_ERROR_TOKEN'); },
    async () => { throw new ProbeClientError('probe_failed'); },
    async () => ({ state: 'background_setup_inspection_complete' }),
  ]) {
    const f = fixture(); f.options.runSelectedProbe = callback;
    const result = await createProbeController(f.options).fetchSelectedConversation({ userGesture: true });
    assert.ok(['failed', 'uncertain'].includes(result.state));
    assert.deepEqual(f.effects, ['collector', 'native', 'close', 'dispose']);
    assert.doesNotMatch(JSON.stringify(f.state), /PRIVATE_ERROR_TOKEN/);
    await createProbeController(f.options).fetchSelectedConversation({ userGesture: true });
    assert.equal(f.effects.filter((effect) => effect === 'native').length, 1);
    originalsPreserved(f.state);
  }
});

test('selected storage read, pre-dispatch write and terminal write failures never refetch', async () => {
  for (const stage of ['read', 'fence', 'running', 'terminal']) {
    const f = fixture();
    const originalGet = f.options.storage.get;
    const originalSet = f.options.storage.set;
    if (stage === 'read') f.options.storage.get = async () => { throw new Error('PRIVATE_STORAGE'); };
    f.options.storage.set = async (update) => {
      if (stage === 'fence' || (stage === 'running' && update[BACKGROUND_SELECTED_STATUS_KEY]?.state === 'running')
        || (stage === 'terminal' && update[BACKGROUND_SELECTED_FENCE_KEY]?.state === 'background_probe_complete')) {
        throw new Error('PRIVATE_STORAGE');
      }
      await originalSet(update);
    };
    const result = await createProbeController(f.options).fetchSelectedConversation({ userGesture: true });
    assert.equal(result.state, 'uncertain');
    if (['read', 'fence'].includes(stage)) assert.deepEqual(f.effects, []);
    else {
      const count = f.effects.filter((value) => value === 'native').length;
      f.options.storage.get = originalGet; f.options.storage.set = originalSet;
      await createProbeController(f.options).fetchSelectedConversation({ userGesture: true });
      assert.equal(f.effects.filter((value) => value === 'native').length, count);
    }
    assert.doesNotMatch(JSON.stringify(f.state), /PRIVATE_STORAGE/);
    originalsPreserved(f.state);
  }
});

test('selected failure persistence is separately keyed and rejects credential-bearing fields', async () => {
  const failure = { protocol_version: 1, operation: 'request_failed',
    request_id: '00000000-0000-4000-8000-000000000021',
    run_id: '00000000-0000-4000-8000-000000000022',
    attempt_id: '00000000-0000-4000-8000-000000000023',
    permit_id: '00000000-0000-4000-8000-000000000024', lease_generation: 0,
    payload: { failure_class: 'identity_mismatch' } };
  const f = fixture();
  f.options.runSelectedProbe = async ({ persistFailure }) => {
    await assert.rejects(() => persistFailure({ ...failure, token: 'PRIVATE_TOKEN' }), ProbeClientError);
    await persistFailure(failure);
    throw new ProbeClientError('probe_failed');
  };
  await createProbeController(f.options).fetchSelectedConversation({ userGesture: true });
  assert.deepEqual(f.state[BACKGROUND_SELECTED_PENDING_FAILURE_KEY], failure);
  assert.doesNotMatch(JSON.stringify(f.state), /PRIVATE_TOKEN/);
  originalsPreserved(f.state);
});

test('selected message gate accepts only an exact internal popup and explicit trusted gesture flag', async () => {
  const f = fixture(); const controller = createProbeController(f.options);
  const message = { type: 'fetch_selected_conversation', user_gesture: true };
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
  for (const untrusted of [{}, { ...sender, tab: {} }, { ...sender, id: 'other' },
    { ...sender, url: 'https://chatgpt.com/' }, { ...sender, url: `${sender.url}?selected=true` }]) {
    await controller.handleMessage(message, untrusted);
  }
  for (const invalid of [{ ...message, url: 'https://example.invalid' }, { type: message.type },
    { ...message, user_gesture: false }, { ...message, conversation_id: 'other-conversation' },
    { ...message, binding: config.binding }]) await controller.handleMessage(invalid, sender);
  assert.deepEqual(f.effects, []);
  assert.equal((await controller.handleMessage({ type: 'selected_status' }, sender)).can_fetch_selected, true);
  assert.deepEqual(f.effects, []);
  assert.equal((await controller.handleMessage(message, sender)).state, 'background_probe_complete');
});

test('selected double clicks and other controllers share one in-flight guard', async () => {
  const f = fixture(); let resolveProbe; let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  f.options.runSelectedProbe = () => { entered(); return new Promise((resolve) => { resolveProbe = resolve; }); };
  const first = createProbeController(f.options).fetchSelectedConversation({ userGesture: true });
  await started;
  const second = createProbeController(f.options);
  assert.equal((await second.fetchSelectedConversation({ userGesture: true })).reason_code, 'busy');
  assert.equal((await second.inspectBackgroundSession({ userGesture: true })).reason_code, 'busy');
  assert.equal((await second.checkConnection({ userGesture: true })).state, 'busy');
  resolveProbe({ state: 'background_probe_complete' }); await first;
  assert.equal(f.effects.filter((effect) => effect === 'native').length, 1);
});

test('public background startup only registers one listener and routes selected status without effects', async () => {
  const f = fixture(); const listeners = [];
  const chromeApi = { runtime: { id: 'test-extension', onMessage: { addListener: (fn) => listeners.push(fn) },
    connectNative: () => assert.fail('public startup must not open native transport') },
  extension: { inIncognitoContext: false }, storage: { local: f.options.storage } };
  const installed = installBackground(chromeApi);
  assert.equal(listeners.length, 1);
  assert.deepEqual(f.state, oldRecords);
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
  const result = await new Promise((resolve) => installed.listener({ type: 'selected_status' }, sender, resolve));
  assert.equal(result.state, 'unconfigured');
  assert.equal(result.can_fetch_selected, false);
  assert.equal(result.scope, 'background-selected-conversation');
  assert.deepEqual(f.state, oldRecords);
});
