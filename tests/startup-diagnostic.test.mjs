import assert from 'node:assert/strict';
import test from 'node:test';
import { createProbeController, CONFIG_KEY, FENCE_KEY, STATUS_KEY, PENDING_FAILURE_KEY,
  STARTUP_DIAGNOSTIC_FENCE_KEY, STARTUP_DIAGNOSTIC_V2_FENCE_KEY } from '../extension/probe-controller.mjs';
import { OWNED_DOCUMENT_KEY, STARTUP_DIAGNOSTIC_DOCUMENT_KEY,
  STARTUP_DIAGNOSTIC_V2_DOCUMENT_KEY, STARTUP_DIAGNOSTIC_V2_FAILURE_CODES } from '../extension/browser-bridge.mjs';
import { ProbeClientError } from '../extension/probe-client.mjs';
import { SETUP_ADAPTER_ID, SETUP_CONTRACT_FINGERPRINT } from '../extension/qualification-config.mjs';

const config = {
  enabled: true, scope: 'setup-inspection',
  browser_instance_id: '00000000-0000-4000-8000-000000000010',
  conversation_id: 'synthetic-selected-conversation',
  binding: { principal_id: 'synthetic-selected-user', context_id: null },
  qualification: { adapter_id: SETUP_ADAPTER_ID, contract_fingerprint: SETUP_CONTRACT_FINGERPRINT },
};
const reviewedAdapters = new Map([[SETUP_ADAPTER_ID, {
  reviewed: true, adapter_id: SETUP_ADAPTER_ID,
  contract_fingerprint: SETUP_CONTRACT_FINGERPRINT, scope: 'setup-inspection',
}]]);
const originalFence = { schema_version: 1, state: 'blocked', reason_code: 'qualification_required' };
const popupSender = { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/popup.html' };

function fixture(initial = {}, overrides = {}) {
  const state = structuredClone({
    [CONFIG_KEY]: config,
    [FENCE_KEY]: originalFence,
    [STATUS_KEY]: { state: 'blocked', reason_code: 'qualification_required' },
    [OWNED_DOCUMENT_KEY]: { state: 'ownership_uncertain', evidence: 'PRIVATE_SENTINEL' },
    [PENDING_FAILURE_KEY]: { evidence: 'PRIVATE_SENTINEL' },
    ...initial,
  });
  const writes = [];
  const inspections = [];
  const storage = {
    async get(keys) { return Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key))
      .map((key) => [key, structuredClone(state[key])])); },
    async set(update) { writes.push(structuredClone(update)); Object.assign(state, structuredClone(update)); },
  };
  const chromeApi = { storage: { local: storage }, runtime: { id: popupSender.id } };
  const options = { chromeApi, storage, config, reviewedAdapters, startupDiagnosticEnabled: true,
    openPage: () => assert.fail('ordinary page must not open'),
    makeNativeClient: () => assert.fail('native must not connect'),
    probe: () => assert.fail('body probe must not run'),
    setupProbe: () => assert.fail('session probe must not run'),
    inspectStartup: async (args) => {
      assert.deepEqual(state[STARTUP_DIAGNOSTIC_FENCE_KEY], {
        schema_version: 1, state: 'starting', reason_code: 'none',
      });
      inspections.push(args);
      return { ok: true };
    }, ...overrides };
  return { state, writes, inspections, storage, options, controller: createProbeController(options) };
}

test('startup diagnostic is read-only until an explicit gesture and never changes original evidence', async () => {
  const f = fixture();
  const before = structuredClone(f.state);
  assert.equal((await f.controller.startupStatus()).can_run, true);
  assert.equal((await f.controller.diagnoseStartup()).reason_code, 'invalid_message');
  assert.equal(f.writes.length, 0);
  assert.equal(f.inspections.length, 0);
  const result = await f.controller.diagnoseStartup({ userGesture: true });
  assert.deepEqual(result, { type: 'startup_diagnostic', state: 'passed',
    reason_code: 'startup_complete', can_run: false });
  assert.equal(f.inspections.length, 1);
  assert.equal(f.inspections[0].initialize.qualification.adapter_id, SETUP_ADAPTER_ID);
  assert.equal(f.inspections[0].initialize.binding.context_id, null);
  for (const [key, value] of Object.entries(before)) assert.deepEqual(f.state[key], value);
  assert.ok(f.writes.every((update) => Object.keys(update).join() === STARTUP_DIAGNOSTIC_FENCE_KEY));
  const restarted = createProbeController(f.options);
  assert.deepEqual(await restarted.startupStatus(), result);
  assert.deepEqual(await restarted.diagnoseStartup({ userGesture: true }), result);
  assert.equal((await restarted.status()).can_inspect, false);
  assert.equal(f.inspections.length, 1);
});

test('private enable flag, private reviewed setup config, and prior failed attempt are all required', async () => {
  const cases = [
    [{}, { startupDiagnosticEnabled: false }, 'diagnostic_disabled'],
    [{}, { config: undefined }, 'configuration_required'],
    [{}, { config: { ...config, enabled: false } }, 'configuration_required'],
    [{}, { reviewedAdapters: new Map() }, 'qualification_required'],
    [{ [FENCE_KEY]: undefined }, {}, 'prior_attempt_required'],
    ...['starting', 'running', 'setup_inspection_complete', 'probe_complete'].map((state) => [
      { [FENCE_KEY]: { schema_version: 1, state, reason_code: 'none' } }, {}, 'prior_attempt_required',
    ]),
  ];
  for (const [initial, options, reason] of cases) {
    const f = fixture(initial, options);
    assert.equal((await f.controller.startupStatus()).reason_code, reason);
    assert.equal((await f.controller.diagnoseStartup({ userGesture: true })).reason_code, reason);
    assert.equal(f.writes.length, 0);
    assert.equal(f.inspections.length, 0);
  }
});

test('orphaned, malformed, or interrupted diagnostic evidence always prevents retry', async () => {
  for (const initial of [
    { [STARTUP_DIAGNOSTIC_DOCUMENT_KEY]: { state: 'opening' } },
    { [STARTUP_DIAGNOSTIC_DOCUMENT_KEY]: null },
    { [STARTUP_DIAGNOSTIC_FENCE_KEY]: {} },
    { [STARTUP_DIAGNOSTIC_FENCE_KEY]: { schema_version: 1, state: 'starting', reason_code: 'none' } },
    { [STARTUP_DIAGNOSTIC_FENCE_KEY]: { schema_version: 1, state: 'passed', reason_code: 'none' } },
    { [STARTUP_DIAGNOSTIC_FENCE_KEY]: { schema_version: 1, state: 'passed', reason_code: 'startup_complete', raw: 'PRIVATE_SENTINEL' } },
  ]) {
    const f = fixture(initial);
    assert.equal((await f.controller.startupStatus()).can_run, false);
    assert.equal((await f.controller.diagnoseStartup({ userGesture: true })).can_run, false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.inspections.length, 0);
  }
});

test('inconsistent original failure fences cannot authorize a startup diagnostic', async () => {
  for (const [state, reason_code] of [['blocked', 'none'], ['failed', 'probe_complete'],
    ['uncertain', 'none'], ['blocked', 'disabled'], ['failed', 'setup_inspection_complete']]) {
    const f = fixture({ [FENCE_KEY]: { schema_version: 1, state, reason_code } });
    assert.equal((await f.controller.startupStatus()).reason_code, 'dispatch_uncertain');
    assert.equal((await f.controller.diagnoseStartup({ userGesture: true })).can_run, false);
    assert.equal(f.inspections.length, 0);
    assert.equal(f.writes.length, 0);
  }
});

test('startup failures are bounded, durable, and do not leak raw errors', async () => {
  for (const code of ['page_tab_failed', 'page_load_failed', 'page_binding_failed',
    'page_initialization_failed', 'page_context_unavailable', 'page_storage_failed',
    'qualification_required', 'document_lost', 'PRIVATE_SENTINEL']) {
    let calls = 0;
    const f = fixture({}, { inspectStartup: async () => {
      calls += 1; throw new ProbeClientError(code);
    } });
    const result = await f.controller.diagnoseStartup({ userGesture: true });
    assert.equal(result.can_run, false);
    assert.equal(result.reason_code, code === 'PRIVATE_SENTINEL' ? 'dispatch_uncertain' : code);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|synthetic-selected|00000000/);
    assert.deepEqual(await createProbeController(f.options).startupStatus(), result);
    await createProbeController(f.options).diagnoseStartup({ userGesture: true });
    assert.equal(calls, 1);
    assert.deepEqual(f.state[FENCE_KEY], originalFence);
  }
});

test('unexpected helper payload cannot pass or escape to the popup', async () => {
  for (const result of [null, { ok: false }, { ok: true, raw: 'PRIVATE_SENTINEL' }]) {
    const f = fixture({}, { inspectStartup: async () => result });
    assert.equal((await f.controller.diagnoseStartup({ userGesture: true })).reason_code, 'dispatch_uncertain');
  }
});

test('diagnostic shares the controller concurrency gate without enabling native or normal probes', async () => {
  let release;
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  const f = fixture({}, { inspectStartup: async () => {
    enter(); await new Promise((resolve) => { release = resolve; }); return { ok: true };
  } });
  const first = f.controller.diagnoseStartup({ userGesture: true });
  await entered;
  const other = createProbeController(f.options);
  assert.equal((await other.diagnoseStartup({ userGesture: true })).reason_code, 'busy');
  assert.equal((await other.checkConnection({ userGesture: true })).state, 'busy');
  assert.equal((await other.inspectSession({ userGesture: true })).reason_code, 'busy');
  assert.equal((await other.startupStatus()).state, 'running');
  release();
  assert.equal((await first).state, 'passed');
});

test('durable start fence precedes effects and terminal write failure remains uncertain after restart', async () => {
  const f = fixture();
  f.storage.set = async () => { throw new Error('PRIVATE_SENTINEL'); };
  assert.equal((await f.controller.diagnoseStartup({ userGesture: true })).reason_code, 'storage_unavailable');
  assert.equal(f.inspections.length, 0);
  const g = fixture();
  const originalSet = g.storage.set;
  g.storage.set = async (update) => {
    if (update[STARTUP_DIAGNOSTIC_FENCE_KEY].state !== 'starting') throw new Error('PRIVATE_SENTINEL');
    return originalSet(update);
  };
  assert.equal((await g.controller.diagnoseStartup({ userGesture: true })).reason_code, 'storage_unavailable');
  assert.equal(g.inspections.length, 1);
  assert.equal((await createProbeController(g.options).startupStatus()).reason_code, 'dispatch_uncertain');
  await createProbeController(g.options).diagnoseStartup({ userGesture: true });
  assert.equal(g.inspections.length, 1);
});

test('only exact internal popup messages can invoke the diagnostic', async () => {
  const f = fixture();
  for (const sender of [{}, { ...popupSender, tab: { id: 1 } },
    { ...popupSender, url: 'https://chatgpt.com/' }, { ...popupSender, id: 'other-extension' }]) {
    assert.equal((await f.controller.handleMessage({ type: 'diagnose_startup', user_gesture: true }, sender)).can_start, false);
  }
  await f.controller.handleMessage({ type: 'diagnose_startup' }, popupSender);
  await f.controller.handleMessage({ type: 'diagnose_startup', user_gesture: false }, popupSender);
  await f.controller.handleMessage({ type: 'diagnose_startup', user_gesture: true, raw: 'PRIVATE_SENTINEL' }, popupSender);
  assert.equal(f.inspections.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.controller.handleMessage({ type: 'startup_status' }, popupSender)).can_run, true);
  assert.equal((await f.controller.handleMessage({ type: 'diagnose_startup', user_gesture: true }, popupSender)).state, 'passed');
  assert.equal(f.inspections.length, 1);
});

function fixtureV2(initial = {}, overrides = {}) {
  return fixture({
    [STARTUP_DIAGNOSTIC_FENCE_KEY]: { schema_version: 1, state: 'blocked', reason_code: 'page_initialization_failed' },
    [STARTUP_DIAGNOSTIC_DOCUMENT_KEY]: { state: 'ownership_uncertain', evidence: 'PRIVATE_SENTINEL' },
    ...initial,
  }, { startupDiagnosticRevision: 2, inspectStartupV2: async () => ({ ok: true }), ...overrides });
}

test('v2 is separately configured and preserves both prior failed attempts byte-for-byte', async () => {
  let calls = 0;
  const f = fixtureV2({}, { inspectStartupV2: async () => {
    assert.deepEqual(f.state[STARTUP_DIAGNOSTIC_V2_FENCE_KEY], {
      schema_version: 1, state: 'starting', reason_code: 'none',
    });
    calls++;
    return { ok: true };
  } });
  const before = structuredClone(f.state);
  const ready = await f.controller.startupStatus();
  assert.deepEqual(ready, { type: 'startup_diagnostic', state: 'ready', reason_code: 'none', can_run: true, revision: 2 });
  assert.equal(f.writes.length, 0);
  const result = await f.controller.diagnoseStartup({ userGesture: true });
  assert.equal(result.state, 'passed');
  assert.equal(result.revision, 2);
  assert.equal(f.inspections.length, 0);
  assert.equal(calls, 1);
  for (const [key, value] of Object.entries(before)) assert.deepEqual(f.state[key], value);
  assert.ok(f.writes.every(update => Object.keys(update).join() === STARTUP_DIAGNOSTIC_V2_FENCE_KEY));
  const restarted = createProbeController(f.options);
  assert.deepEqual(await restarted.diagnoseStartup({ userGesture: true }), result);
  assert.equal(calls, 1);
  assert.equal((await restarted.status()).can_inspect, false);
  const original = createProbeController({ ...f.options, startupDiagnosticRevision: 1 });
  assert.equal((await original.startupStatus()).reason_code, 'page_initialization_failed');
  assert.equal((await original.diagnoseStartup({ userGesture: true })).can_run, false);
});

test('v2 requires the precise prior unresolved diagnostic and never treats orphaned state as ready', async () => {
  for (const prior of [undefined, { schema_version: 1, state: 'passed', reason_code: 'startup_complete' },
    { schema_version: 1, state: 'starting', reason_code: 'none' },
    { schema_version: 1, state: 'blocked', reason_code: 'page_context_unavailable' },
    { schema_version: 1, state: 'blocked', reason_code: 'none' }, {}]) {
    const f = fixtureV2({ [STARTUP_DIAGNOSTIC_FENCE_KEY]: prior });
    assert.equal((await f.controller.startupStatus()).can_run, false);
    assert.equal((await f.controller.diagnoseStartup({ userGesture: true })).can_run, false);
    assert.equal(f.writes.length, 0);
  }
  for (const initial of [
    { [STARTUP_DIAGNOSTIC_V2_DOCUMENT_KEY]: { state: 'opening' } },
    { [STARTUP_DIAGNOSTIC_V2_FENCE_KEY]: { schema_version: 1, state: 'starting', reason_code: 'none' } },
    { [STARTUP_DIAGNOSTIC_V2_FENCE_KEY]: {} },
  ]) {
    const f = fixtureV2(initial);
    assert.equal((await f.controller.diagnoseStartup({ userGesture: true })).can_run, false);
    assert.equal(f.writes.length, 0);
  }
});

test('each v2 fixed boundary failure is persisted without leaking raw diagnostics or allowing retry', async () => {
  for (const code of STARTUP_DIAGNOSTIC_V2_FAILURE_CODES) {
    let calls = 0;
    const f = fixtureV2({}, { inspectStartupV2: async () => {
      calls++; const error = new ProbeClientError(code); error.details = 'PRIVATE_SENTINEL'; throw error;
    } });
    const before = structuredClone(f.state);
    const result = await f.controller.diagnoseStartup({ userGesture: true });
    assert.deepEqual(result, { type: 'startup_diagnostic', state: 'blocked', reason_code: code, can_run: false, revision: 2 });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|synthetic|00000000/);
    const restarted = createProbeController(f.options);
    assert.deepEqual(await restarted.startupStatus(), result);
    assert.deepEqual(await restarted.diagnoseStartup({ userGesture: true }), result);
    assert.equal(calls, 1);
    for (const [key, value] of Object.entries(before)) assert.deepEqual(f.state[key], value);
  }
});

test('storage and popup messages cannot select a new diagnostic revision', async () => {
  const f = fixtureV2({ startupDiagnosticRevision: 2 }, { startupDiagnosticEnabled: false });
  assert.equal((await f.controller.startupStatus()).state, 'disabled');
  await f.controller.handleMessage({ type: 'diagnose_startup', user_gesture: true, revision: 2 }, popupSender);
  assert.equal(f.writes.length, 0);
  for (const revision of [0, 3, '2', null]) {
    assert.throws(() => createProbeController({ ...f.options, startupDiagnosticRevision: revision }),
      { code: 'invalid_probe_configuration' });
  }
});
