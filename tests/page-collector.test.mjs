import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { pageCollector } from '../extension/page-collector.mjs';

const PRINCIPAL = 'principal-synthetic';
const CONTEXT = 'context-synthetic';
const CONVERSATION = 'conversation-synthetic';
const AUTH_SENTINEL = 'AUTH_TOKEN_SENTINEL';
const COOKIE_SENTINEL = 'COOKIE_SENTINEL';
const SETUP_PRINCIPAL = 'setup-principal';
const SETUP_CONTEXT = 'setup-personal-context';
const SETUP_ADAPTER = 'chatgpt-setup-2026-09-16';
const SESSION_PERMIT = '11111111-1111-4111-8111-111111111111';
const BODY_PERMIT = '22222222-2222-4222-8222-222222222222';
const EXPIRED_PERMIT = '33333333-3333-4333-8333-333333333333';

function responseFromBytes(input, parts = null, status = 200, headers = {}) {
  const bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(input);
  const chunks = parts ?? [bytes];
  let index = 0;
  let cancelled = false;
  return {
    status,
    headers: { get(name) { return headers[name.toLowerCase()] ?? null; } },
    body: {
      getReader() {
        return {
          async read() {
            if (cancelled) return { done: true, value: undefined };
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
          async cancel() { cancelled = true; },
        };
      },
    },
  };
}

function sessionResponse({ principal = PRINCIPAL, context = CONTEXT } = {}) {
  return responseFromBytes(JSON.stringify({
    user: { id: principal }, context: { id: context },
    token: AUTH_SENTINEL, cookie: COOKIE_SENTINEL,
  }));
}

function jwtFor(context = SETUP_CONTEXT, payload = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: context }, ...payload,
  })}.signature`;
}

function setupSessionResponse({ principal = SETUP_PRINCIPAL, context = SETUP_CONTEXT,
  structure = 'personal', accessToken = jwtFor(context), headers = { 'content-type': 'application/json' },
  sessionFields = {}, ...responseOptions } = {}) {
  const response = responseFromBytes(JSON.stringify({
    user: { id: principal }, account: { id: context, structure }, accessToken,
    token: AUTH_SENTINEL, cookie: COOKIE_SENTINEL, ...sessionFields,
  }), null, 200, headers);
  return Object.assign(response, responseOptions);
}

function bodyResponse(content = 'synthetic body', parts = null) {
  return responseFromBytes(JSON.stringify({
    conversation: { id: CONVERSATION }, content,
  }), parts);
}

function makeRealm(fetchImpl, timer = setTimeout, { origin = 'https://miyo-catchup.invalid', cookie } = {}) {
  let monotonic = 0;
  const context = vm.createContext({
    AbortController,
    TextDecoder,
    TextEncoder,
    atob,
    btoa,
    crypto: {
      subtle: {
        digest: async (_algorithm, bytes) => createHash('sha256').update(Buffer.from(bytes)).digest(),
      },
    },
    fetch: fetchImpl,
    performance: { now: () => monotonic },
    location: { origin },
    document: { cookie },
    setTimeout: timer,
    clearTimeout,
    __MIYO_CATCHUP_SYNTHETIC_TEST__: true,
  });
  context.collector = vm.runInContext(`(${pageCollector.toString()})`, context);
  return {
    context,
    advance(ms) { monotonic += ms; },
    async call(command) {
      context.commandJson = JSON.stringify(command);
      const reply = await vm.runInContext('collector(JSON.parse(commandJson))', context);
      return JSON.parse(JSON.stringify(reply));
    },
  };
}

function initialize() {
  return {
    operation: 'initialize',
    binding: { principal_id: PRINCIPAL, context_id: CONTEXT },
    conversation_id: CONVERSATION,
    qualification: { adapter_id: 'synthetic-v1' },
  };
}

function setupInitialize() {
  return {
    operation: 'initialize',
    binding: { principal_id: SETUP_PRINCIPAL, context_id: null },
    conversation_id: CONVERSATION,
    qualification: { adapter_id: SETUP_ADAPTER },
  };
}

function permit(kind, id, args = {}) {
  return {
    operation: 'dispatch',
    permit: {
      permit_id: id,
      request_kind: kind,
      arguments: args,
      valid_until: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

async function pullAll(realm, raw = []) {
  for (let sequence = 0; ; sequence += 1) {
    const reply = await realm.call({ operation: 'pull', sequence });
    assert.equal(reply.ok, true);
    raw.push(Buffer.from(reply.data, 'base64'));
    if (reply.decoded_bytes < 180 * 1024) return Buffer.concat(raw);
  }
}

test('T02 collector function is self-contained and production entry fails closed', async () => {
  const source = readFileSync(new URL('../extension/page-collector.mjs', import.meta.url), 'utf8');
  assert.match(source, /export function pageCollector/);
  const context = vm.createContext({
    fetch: async () => sessionResponse(), TextDecoder, TextEncoder,
    performance: { now: () => 0 },
    location: { origin: 'https://chatgpt.com' },
  });
  context.collector = vm.runInContext(`(${pageCollector.toString()})`, context);
  context.commandJson = JSON.stringify(initialize());
  const reply = JSON.parse(JSON.stringify(await vm.runInContext('collector(JSON.parse(commandJson))', context)));
  assert.deepEqual(reply, { ok: false, error: { failure_class: 'schema_changed' } });
  assert.doesNotMatch(JSON.stringify(reply), /TOKEN|COOKIE|sessionResponse/);
});

test('AC01/AC02 session is a separate sanitized transfer and body uses one fixed approved ID', async () => {
  const calls = [];
  const realm = makeRealm(async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/auth/session') return sessionResponse();
    if (url === '/backend-api/conversations/batch') return bodyResponse('😀 漢字');
    throw new Error('unexpected route');
  });
  assert.deepEqual(await realm.call(initialize()), { ok: true });
  const session = await realm.call(permit('session_check', SESSION_PERMIT));
  assert.equal(session.ok, true);
  const sessionBytes = await pullAll(realm);
  const sessionResult = JSON.parse(sessionBytes.toString('utf8'));
  assert.deepEqual(sessionResult, { principal_id: PRINCIPAL, context_id: CONTEXT });
  assert.doesNotMatch(sessionBytes.toString('utf8'), /TOKEN|COOKIE/);
  await realm.call({ operation: 'release' });
  realm.advance(5000);
  const body = await realm.call(permit('body', BODY_PERMIT, { conversation_ids: [CONVERSATION] }));
  assert.equal(body.ok, true);
  const bodyBytes = await pullAll(realm);
  assert.match(bodyBytes.toString('utf8'), /😀 漢字/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/api/auth/session');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].url, '/backend-api/conversations/batch');
  assert.deepEqual(JSON.parse(calls[1].options.body), { conversation_ids: [CONVERSATION] });
  assert.deepEqual(Object.keys(calls[1].options.headers).sort(), ['authorization', 'content-type']);
  assert.equal(calls[1].options.headers.authorization, `Bearer ${AUTH_SENTINEL}`);
});

test('setup inspection is ChatGPT-only, personal-only, sanitized, and never admits body work', async () => {
  const calls = [];
  const realm = makeRealm(async (url, options) => {
    calls.push({ url, options });
    return url === '/api/auth/session' ? setupSessionResponse() : bodyResponse();
  }, setTimeout, { origin: 'https://chatgpt.com', cookie: '_account=personal' });
  assert.deepEqual(await realm.call(setupInitialize()), { ok: true });
  const session = await realm.call(permit('session_check', SESSION_PERMIT));
  assert.equal(session.ok, true);
  const bytes = await pullAll(realm);
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), {
    principal_id: SETUP_PRINCIPAL, context_id: SETUP_CONTEXT,
  });
  assert.doesNotMatch(bytes.toString('utf8'), /AUTH_TOKEN|COOKIE/);
  assert.deepEqual(await realm.call({ operation: 'release' }), { ok: true });
  assert.deepEqual(await realm.call(permit('body', BODY_PERMIT, { conversation_ids: [CONVERSATION] })),
    { ok: false, error: { failure_class: 'schema_changed' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/auth/session');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'same-origin');
});

test('setup inspection rejects origin, body attempts, wrong principal, nonpersonal and malformed JWT before exposure', async () => {
  const wrongOrigin = makeRealm(async () => setupSessionResponse(), setTimeout,
    { origin: 'https://miyo-catchup.invalid', cookie: '_account=personal' });
  assert.deepEqual(await wrongOrigin.call(setupInitialize()),
    { ok: false, error: { failure_class: 'schema_changed' } });
  for (const response of [
    setupSessionResponse({ principal: 'wrong-principal' }),
    setupSessionResponse({ structure: 'workspace' }),
    setupSessionResponse({ accessToken: 'not-a-jwt' }),
    setupSessionResponse({ accessToken: jwtFor('other-context') }),
    setupSessionResponse({ sessionFields: { error: 'session-error' } }),
    setupSessionResponse({ sessionFields: { workspaceTokenExchangeError: 'exchange-error' } }),
  ]) {
    const realm = makeRealm(async () => response, setTimeout,
      { origin: 'https://chatgpt.com', cookie: '_account=personal' });
    assert.deepEqual(await realm.call(setupInitialize()), { ok: true });
    assert.deepEqual(await realm.call(permit('session_check', randomUUID())),
      { ok: false, error: { failure_class: 'identity_mismatch' } });
  }
});

test('setup inspection fails closed for absent, duplicate, malformed, or foreign account selection', async () => {
  for (const cookie of [undefined, '', '_account=personal; _account=personal',
    '_account=%E0%A4%A']) {
    const realm = makeRealm(async () => setupSessionResponse(), setTimeout,
      { origin: 'https://chatgpt.com', cookie });
    assert.deepEqual(await realm.call(setupInitialize()),
      { ok: false, error: { failure_class: 'identity_mismatch' } });
  }
  const foreign = makeRealm(async () => setupSessionResponse(), setTimeout,
    { origin: 'https://chatgpt.com', cookie: '_account=workspace-other' });
  await foreign.call(setupInitialize());
  assert.deepEqual(await foreign.call(permit('session_check', randomUUID())),
    { ok: false, error: { failure_class: 'identity_mismatch' } });
  const exact = makeRealm(async () => setupSessionResponse(), setTimeout,
    { origin: 'https://chatgpt.com', cookie: `_account=${SETUP_CONTEXT}` });
  assert.deepEqual(await exact.call(setupInitialize()), { ok: true });
  assert.equal((await exact.call(permit('session_check', randomUUID()))).ok, true);
});

test('setup inspection detects account selection changes after response and before pull', async () => {
  const realm = makeRealm(async () => setupSessionResponse(), setTimeout,
    { origin: 'https://chatgpt.com', cookie: '_account=personal' });
  await realm.call(setupInitialize());
  const dispatch = await realm.call(permit('session_check', randomUUID()));
  assert.equal(dispatch.ok, true);
  realm.context.document.cookie = `_account=${SETUP_CONTEXT}`;
  assert.deepEqual(await realm.call({ operation: 'pull', sequence: 0 }),
    { ok: false, error: { failure_class: 'identity_mismatch' } });
  assert.deepEqual(await realm.call({ operation: 'pull', sequence: 0 }),
    { ok: false, error: { failure_class: 'aborted' } });
});

test('setup inspection rechecks selection on final release before any commit can occur', async () => {
  const realm = makeRealm(async () => setupSessionResponse(), setTimeout,
    { origin: 'https://chatgpt.com', cookie: '_account=personal' });
  await realm.call(setupInitialize());
  const dispatch = await realm.call(permit('session_check', randomUUID()));
  assert.equal(dispatch.ok, true);
  assert.equal((await realm.call({ operation: 'pull', sequence: 0 })).ok, true);
  realm.context.document.cookie = `_account=${SETUP_CONTEXT}`;
  assert.deepEqual(await realm.call({ operation: 'release' }),
    { ok: false, error: { failure_class: 'identity_mismatch' } });
  assert.deepEqual(await realm.call({ operation: 'pull', sequence: 0 }),
    { ok: false, error: { failure_class: 'aborted' } });
});

test('setup inspection rejects a selection change while the session request is in flight', async () => {
  let realm;
  realm = makeRealm(async () => {
    realm.context.document.cookie = `_account=${SETUP_CONTEXT}`;
    return setupSessionResponse();
  }, setTimeout, { origin: 'https://chatgpt.com', cookie: '_account=personal' });
  await realm.call(setupInitialize());
  assert.deepEqual(await realm.call(permit('session_check', randomUUID())),
    { ok: false, error: { failure_class: 'identity_mismatch' } });
});

test('setup inspection requires JSON content and rejects observable redirects before parsing', async () => {
  for (const response of [
    setupSessionResponse({ headers: {} }),
    setupSessionResponse({ redirected: true }),
    setupSessionResponse({ type: 'opaqueredirect' }),
  ]) {
    const realm = makeRealm(async () => response, setTimeout,
      { origin: 'https://chatgpt.com', cookie: '_account=personal' });
    await realm.call(setupInitialize());
    const reply = await realm.call(permit('session_check', randomUUID()));
    assert.deepEqual(reply, { ok: false, error: { failure_class: 'schema_changed' } });
  }
  const charset = makeRealm(async () => setupSessionResponse({
    headers: { 'content-type': 'application/json; charset=utf-8' },
  }), setTimeout, { origin: 'https://chatgpt.com', cookie: '_account=personal' });
  await charset.call(setupInitialize());
  assert.equal((await charset.call(permit('session_check', randomUUID()))).ok, true);
});

test('setup inspection preserves fixed status classification without JSON headers', async () => {
  for (const [status, expected] of [[401, 'auth_required'], [403, 'challenge']]) {
    const realm = makeRealm(async () => responseFromBytes('html error', [], status), setTimeout,
      { origin: 'https://chatgpt.com', cookie: '_account=personal' });
    await realm.call(setupInitialize());
    const reply = await realm.call(permit('session_check', randomUUID()));
    assert.deepEqual(reply, { ok: false, error: { failure_class: expected, http_status: status } });
  }
  const throttled = makeRealm(async () => responseFromBytes('html error', [], 429,
    { 'retry-after': '3601' }), setTimeout,
  { origin: 'https://chatgpt.com', cookie: '_account=personal' });
  await throttled.call(setupInitialize());
  assert.deepEqual(await throttled.call(permit('session_check', randomUUID())), {
    ok: false,
    error: { failure_class: 'rate_limited', http_status: 429, retry_after: '3601' },
  });
});

test('AC02 rejects context mismatch and standalone or foreign body permits before fetch', async () => {
  let calls = 0;
  const realm = makeRealm(async () => { calls += 1; return sessionResponse({ context: 'other-context' }); });
  await realm.call(initialize());
  const standalone = await realm.call(permit('body', BODY_PERMIT, { conversation_ids: [CONVERSATION] }));
  assert.deepEqual(standalone, { ok: false, error: { failure_class: 'schema_changed' } });
  const mismatch = await realm.call(permit('session_check', SESSION_PERMIT));
  assert.deepEqual(mismatch, { ok: false, error: { failure_class: 'identity_mismatch' } });
  assert.equal(calls, 1);

  const foreign = makeRealm(async () => { calls += 1; return sessionResponse(); });
  await foreign.call(initialize());
  assert.deepEqual(await foreign.call(permit('body', BODY_PERMIT, { conversation_ids: ['other-conversation'] })),
    { ok: false, error: { failure_class: 'identity_mismatch' } });
});

test('AC06 expires and consumes permits, and enforces five-second monotonic spacing', async () => {
  const realm = makeRealm(async () => sessionResponse());
  await realm.call(initialize());
  const expired = await realm.call({ operation: 'dispatch', permit: {
    permit_id: EXPIRED_PERMIT, request_kind: 'session_check', arguments: {}, valid_until: new Date(Date.now() - 1).toISOString(),
  } });
  assert.deepEqual(expired, { ok: false, error: { failure_class: 'schema_changed' } });
  const first = await realm.call(permit('session_check', SESSION_PERMIT));
  assert.equal(first.ok, true);
  assert.deepEqual(await realm.call(permit('session_check', SESSION_PERMIT)), { ok: false, error: { failure_class: 'schema_changed' } });
  await pullAll(realm);
  await realm.call({ operation: 'release' });
  assert.deepEqual(await realm.call(permit('body', BODY_PERMIT, { conversation_ids: [CONVERSATION] })),
    { ok: false, error: { failure_class: 'schema_changed' } });
});

test('AC13 chunks split UTF-8 and digest the exact bounded body bytes', async () => {
  const body = JSON.stringify({ conversation: { id: CONVERSATION }, content: 'split 😀 漢字' });
  const bytes = new TextEncoder().encode(body);
  const parts = Array.from({ length: bytes.length }, (_, index) => bytes.slice(index, index + 1));
  const realm = makeRealm(async (url) => url === '/api/auth/session' ? sessionResponse() : bodyResponse('ignored', parts));
  await realm.call(initialize());
  await realm.call(permit('session_check', SESSION_PERMIT));
  await pullAll(realm);
  await realm.call({ operation: 'release' });
  realm.advance(5000);
  const reply = await realm.call(permit('body', BODY_PERMIT, { conversation_ids: [CONVERSATION] }));
  assert.equal(reply.ok, true);
  assert.equal(reply.raw_bytes, bytes.length);
  assert.equal(reply.sha256, createHash('sha256').update(bytes).digest('hex'));
  const received = await pullAll(realm);
  assert.deepEqual(new Uint8Array(received), bytes);
});

test('AC13 refuses one byte over the page response cap before allocation/parse', async () => {
  const realm = makeRealm(async (url) => {
    if (url === '/api/auth/session') return sessionResponse();
    return {
      status: 200,
      body: { getReader: () => ({
        async read() { return { done: false, value: { byteLength: (64 * 1024 * 1024) + 1 } }; },
        async cancel() {},
      }) },
    };
  });
  await realm.call(initialize());
  await realm.call(permit('session_check', SESSION_PERMIT));
  await pullAll(realm);
  await realm.call({ operation: 'release' });
  realm.advance(5000);
  assert.deepEqual(await realm.call(permit('body', BODY_PERMIT, { conversation_ids: [CONVERSATION] })),
    { ok: false, error: { failure_class: 'schema_changed' } });
});

test('errors are allowlisted and never expose exception text or auth responses', async () => {
  for (const expected of ['network', 'auth_required', 'challenge_required', 'rate_limited']) {
    const realm = makeRealm(async () => {
      if (expected === 'network') throw new Error('PRIVATE_EXCEPTION_SENTINEL');
      return responseFromBytes('', [], { network: 500, auth_required: 401, challenge_required: 403, rate_limited: 429 }[expected]);
    });
    await realm.call(initialize());
    const reply = await realm.call(permit('session_check', {
      network: '44444444-4444-4444-8444-444444444444',
      auth_required: '55555555-5555-4555-8555-555555555555',
      challenge_required: '66666666-6666-4666-8666-666666666666',
      rate_limited: '77777777-7777-4777-8777-777777777777',
    }[expected]));
    const status = { auth_required: 401, challenge_required: 403, rate_limited: 429 }[expected];
    assert.deepEqual(reply, { ok: false, error: {
      failure_class: expected === 'challenge_required' ? 'challenge' : expected,
      ...(status ? { http_status: status } : {}),
    } });
    assert.doesNotMatch(JSON.stringify(reply), /PRIVATE_EXCEPTION|TOKEN|COOKIE|stack|message/);
  }
});

test('abort fences an in-flight request and subsequent pulls report lost/closed buffer', async () => {
  let rejectFetch;
  const realm = makeRealm(async (_url, options) => new Promise((_resolve, reject) => {
    rejectFetch = reject;
    options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('PRIVATE_ABORT_SENTINEL'), { name: 'AbortError' })));
  }));
  await realm.call(initialize());
  const pending = realm.call(permit('session_check', SESSION_PERMIT));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await realm.call({ operation: 'abort' }), { ok: true });
  assert.deepEqual(await pending, { ok: false, error: { failure_class: 'aborted' } });
  assert.deepEqual(await realm.call({ operation: 'pull', sequence: 0 }), { ok: false, error: { failure_class: 'aborted' } });
  rejectFetch?.(new Error('PRIVATE_ABORT_SENTINEL'));
});

test('pull without a response buffer is a bounded lost-buffer error', async () => {
  const realm = makeRealm(async () => sessionResponse());
  await realm.call(initialize());
  assert.deepEqual(await realm.call({ operation: 'pull', sequence: 0 }), { ok: false, error: { failure_class: 'aborted' } });
});

test('AC06 replays delivered chunks for a lost ACK, rejects gaps, and releases only after drain', async () => {
  const realm = makeRealm(async () => sessionResponse());
  await realm.call(initialize());
  await realm.call(permit('session_check', SESSION_PERMIT));
  const first = await realm.call({ operation: 'pull', sequence: 0 });
  const replay = await realm.call({ operation: 'pull', sequence: 0 });
  assert.deepEqual(replay, first);
  assert.deepEqual(await realm.call({ operation: 'pull', sequence: 1 }),
    { ok: false, error: { failure_class: 'schema_changed' } });
  assert.deepEqual(await realm.call({ operation: 'release' }), { ok: true });
  assert.deepEqual(await realm.call({ operation: 'pull', sequence: 0 }),
    { ok: false, error: { failure_class: 'aborted' } });
});

test('AC06 preserves a bounded long Retry-After and sanitizes malformed or oversized headers', async () => {
  const cases = [
    { value: '86400', expected: '86400' },
    { value: 'not-a-date', expected: 'invalid' },
    { value: 'x'.repeat(129), expected: 'invalid' },
  ];
  for (const item of cases) {
    const realm = makeRealm(async () => responseFromBytes('', [], 429, { 'retry-after': item.value }));
    await realm.call(initialize());
    const reply = await realm.call(permit('session_check', SESSION_PERMIT));
    assert.deepEqual(reply, { ok: false, error: {
      failure_class: 'rate_limited', http_status: 429, retry_after: item.expected,
    } });
    assert.doesNotMatch(JSON.stringify(reply), /not-a-date|x{129}/);
  }
});

test('AC06 bounds a never-settling fetch or reader with the fixed 30-second deadline', async () => {
  const never = () => new Promise(() => {});
  for (const fetchImpl of [never, async () => ({ status: 200,
    body: { getReader: () => ({ read: never, cancel: async () => { throw new Error('synthetic-cancel-error'); } }) } })]) {
    const realm = makeRealm(fetchImpl, (fn, ms) => {
      assert.equal(ms, 30000);
      return setTimeout(fn, 1); // virtualized deadline, no wall-clock delay
    });
    await realm.call(initialize());
    assert.deepEqual(await realm.call(permit('session_check', SESSION_PERMIT)),
      { ok: false, error: { failure_class: 'timeout' } });
  }
});

test('AC06 abort settles even a fetch that ignores AbortSignal', async () => {
  const realm = makeRealm(() => new Promise(() => {}));
  await realm.call(initialize());
  const dispatch = realm.call(permit('session_check', SESSION_PERMIT));
  await realm.call({ operation: 'abort' });
  assert.deepEqual(await dispatch, { ok: false, error: { failure_class: 'aborted' } });
});
