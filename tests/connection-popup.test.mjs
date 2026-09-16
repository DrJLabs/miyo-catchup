import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { checkNativeConnection, isConnectionCheckReply } from '../extension/connection-check.mjs';
import { createProbeController, FENCE_KEY } from '../extension/probe-controller.mjs';
import { assertReply } from '../src/contracts.mjs';
import { createConnectionCheckReceiver } from '../src/connection-check.mjs';

const requestId = '00000000-0000-4000-8000-000000000031';
function reply(now = Date.now()) {
  const stamp = new Date(now).toISOString();
  return { protocol_version: 1, request_id: requestId, ok: true, result: { status: {
    status_version: 1, generated_at: stamp, heartbeat_at: stamp,
    worker_instance_id: '00000000-0000-4000-8000-000000000032',
    worker_version: '0.0.0-t02-connection', connectivity: 'available', liveness: 'live',
    run: null, blockers: ['blocked'], primary_blocker: 'blocked',
    pause_requested: false, paused_at_safe_boundary: false,
    last_complete_scan: null, last_fully_verified_run: null, receipt_evidence_at: null,
    next_scheduled_due_at: null, cooldown_until: null, retry_at: null, error_code: 'blocked',
    budget_remaining: { session_requests: 0, catalog_pages: 0, body_requests: 0, total_requests: 0, attempts: 0 },
  } } };
}

test('connection check uses one existing get_status request and closes without other effects', async () => {
  const now = Date.now();
  const response = reply(now);
  assertReply(response, 'get_status');
  const calls = [];
  const result = await checkNativeConnection({ chromeApi: {}, uuid: () => requestId, now: () => now,
    makeNativeClient(_api, options) {
      calls.push(options);
      return { async request(message) { calls.push(message); return response; }, close() { calls.push('close'); } };
    } });
  assert.deepEqual(result, { type: 'connection_check', state: 'passed' });
  assert.deepEqual(calls, [{ timeoutMs: 10000 },
    { protocol_version: 1, request_id: requestId, operation: 'get_status', payload: {} }, 'close']);
});

test('only fresh capture-disabled status is accepted; malformed or secret-bearing replies fail closed', () => {
  const now = Date.now();
  assert.equal(isConnectionCheckReply(reply(now), requestId, now), true);
  for (const mutate of [
    (v) => { v.request_id = 'wrong'; },
    (v) => { v.protocol_version = 2; },
    (v) => { v.error = { code: 'blocked' }; },
    (v) => { v.result.token = 'SYNTHETIC_SECRET'; },
    (v) => { v.result.status.account_id = 'SYNTHETIC_PRIVATE'; },
    (v) => { v.result.status.worker_version = '0.0.0'; },
    (v) => { v.result.status.worker_instance_id = null; },
    (v) => { v.result.status.run = {}; },
    (v) => { v.result.status.blockers = []; },
    (v) => { v.result.status.budget_remaining.body_requests = 1; },
    (v) => { v.result.status.last_fully_verified_run = {}; },
    (v) => { v.result.status.heartbeat_at = 'not-a-date'; },
    (v) => { v.result.status.generated_at = v.result.status.heartbeat_at = new Date(now - 30001).toISOString(); },
    (v) => { v.result.status.generated_at = v.result.status.heartbeat_at = new Date(now + 5001).toISOString(); },
  ]) {
    const changed = reply(now); mutate(changed);
    assert.equal(isConnectionCheckReply(changed, requestId, now), false);
  }
  const impossibleDate = reply(now);
  impossibleDate.result.status.generated_at = impossibleDate.result.status.heartbeat_at = '2026-02-30T00:00:00.000Z';
  assert.equal(isConnectionCheckReply(impossibleDate, requestId, Date.parse('2026-03-02T00:00:00.000Z')), false);
});

test('connection errors are sanitized, closed and never retried', async () => {
  let sends = 0;
  let closes = 0;
  const result = await checkNativeConnection({ uuid: () => requestId,
    makeNativeClient() { return {
      async request() { sends += 1; throw new Error('SYNTHETIC_PRIVATE_NATIVE_ERROR'); },
      close() { closes += 1; },
    }; } });
  assert.deepEqual(result, { type: 'connection_check', state: 'unavailable' });
  assert.equal(sends, 1); assert.equal(closes, 1);
});

test('browser checker and actual local-only receiver agree on the existing wire contract', async () => {
  const receiver = createConnectionCheckReceiver();
  const result = await checkNativeConnection({ uuid: () => requestId,
    makeNativeClient() { return { request: receiver.request, close() {} }; } });
  assert.equal(result.state, 'passed');
  assert.equal(receiver.requestCount, 1);
});

function controllerFixture() {
  let calls = 0;
  const state = { [FENCE_KEY]: { schema_version: 1, state: 'uncertain', reason_code: 'dispatch_uncertain' } };
  const storage = { async get() { throw new Error('must not read capture configuration'); },
    async set() { throw new Error('must not rewrite capture fence'); } };
  const chromeApi = { runtime: { id: 'a'.repeat(32) }, storage: { local: storage } };
  const sender = { id: chromeApi.runtime.id, url: `chrome-extension://${chromeApi.runtime.id}/popup.html` };
  const controller = createProbeController({ chromeApi, storage, uuid: () => requestId,
    openPage() { throw new Error('must not open a page'); },
    makeNativeClient() { calls += 1; return { async request() { return reply(); }, close() {} }; } });
  return { controller, sender, state, calls: () => calls };
}

test('only exact internal popup and explicit gesture can check transport; capture fence is untouched', async () => {
  const f = controllerFixture();
  for (const [message, sender] of [
    [{ type: 'check_connection' }, f.sender],
    [{ type: 'check_connection', user_gesture: false }, f.sender],
    [{ type: 'check_connection', user_gesture: true }, { ...f.sender, tab: {} }],
    [{ type: 'check_connection', user_gesture: true }, { ...f.sender, url: 'https://chatgpt.com/' }],
    [{ type: 'check_connection', user_gesture: true, extra: 'ignored?' }, f.sender],
  ]) await f.controller.handleMessage(message, sender);
  assert.equal(f.calls(), 0);
  const before = structuredClone(f.state);
  const result = await f.controller.handleMessage({ type: 'check_connection', user_gesture: true }, f.sender);
  assert.equal(result.state, 'passed');
  assert.deepEqual(f.state, before);
  assert.equal(f.calls(), 1);
});

test('connection check and capture share one in-process flight guard', async () => {
  let release;
  let opens = 0;
  const storage = { get: async () => ({}), set: async () => {} };
  const controller = createProbeController({ chromeApi: { storage: { local: storage } }, storage,
    uuid: () => requestId, makeNativeClient() { opens += 1; return {
      request: () => new Promise((resolve) => { release = resolve; }), close() {},
    }; } });
  const pending = controller.checkConnection({ userGesture: true });
  assert.equal((await controller.checkConnection({ userGesture: true })).state, 'busy');
  assert.equal((await controller.start({ userGesture: true })).reason_code, 'busy');
  release(reply()); await pending;
  assert.equal(opens, 1);
});

function popup(sendMessage) {
  const nodes = new Map(['#status', '#start', '#check-connection', '#connection-status'].map((id) => [id, {
    textContent: '', disabled: id === '#start', handlers: {},
    addEventListener(name, handler) { this.handlers[name] = handler; },
  }]));
  const context = vm.createContext({ document: { querySelector: (id) => nodes.get(id) },
    chrome: { runtime: { sendMessage } } });
  vm.runInContext(readFileSync(new URL('../extension/popup.mjs', import.meta.url), 'utf8'), context);
  return nodes;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('popup starts with status only; explicit connection result never enables Start', async () => {
  const calls = [];
  const nodes = popup(async (message) => {
    calls.push(message.type);
    return message.type === 'status' ? { state: 'unconfigured', can_start: false }
      : { type: 'connection_check', state: 'passed', token: 'SYNTHETIC_PRIVATE' };
  });
  await settle();
  assert.deepEqual(calls, ['status']);
  nodes.get('#check-connection').handlers.click({ isTrusted: false });
  assert.deepEqual(calls, ['status']);
  nodes.get('#check-connection').handlers.click({ isTrusted: true });
  assert.equal(nodes.get('#check-connection').disabled, true);
  assert.equal(nodes.get('#start').disabled, true);
  await settle();
  assert.deepEqual(calls, ['status', 'check_connection']);
  assert.equal(nodes.get('#start').disabled, true);
  assert.equal(nodes.get('#check-connection').disabled, false);
  assert.equal(nodes.get('#connection-status').textContent, 'Local connection check passed. Capture is still disabled.');
  assert.equal(nodes.get('#status').textContent, 'Private qualification is not configured.');
});

test('popup isolates connection failures and late status replies during a pending check', async () => {
  let finishStatus;
  let finishCheck;
  const nodes = popup((message) => new Promise((resolve, reject) => {
    if (message.type === 'status') finishStatus = resolve;
    else finishCheck = reject;
  }));
  nodes.get('#check-connection').handlers.click({ isTrusted: true });
  finishStatus({ state: 'ready', can_start: true });
  await settle();
  assert.equal(nodes.get('#start').disabled, true);
  finishCheck(new Error('SYNTHETIC_PRIVATE_ERROR'));
  await settle();
  assert.equal(nodes.get('#connection-status').textContent.includes('SYNTHETIC'), false);
  assert.equal(nodes.get('#check-connection').disabled, false);
});
