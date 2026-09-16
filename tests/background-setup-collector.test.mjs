import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createBackgroundSetupCollector } from '../extension/background-setup-collector.mjs';
import { ProbeClientError } from '../extension/probe-client.mjs';

const NOW = 1_700_000_000_000;
const PRINCIPAL = 'principal-background';
const CONTEXT = 'account-personal';
const COLLECTOR_ID = '00000000-0000-4000-8000-000000000020';
const PERMIT_ID = '11111111-1111-4111-8111-111111111111';
const BOUNDARY_ID = '22222222-2222-4222-8222-222222222222';
const binding = { principal_id: PRINCIPAL, context_id: null };

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwtFor(account = CONTEXT, exp = NOW / 1000 + 3600, extra = {}) {
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    exp, 'https://api.openai.com/auth': { chatgpt_account_id: account }, ...extra,
  })}.signature`;
}

function bodyBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function response(value, { status = 200, headers = { 'content-type': 'application/json' },
  chunks, redirected, type } = {}) {
  const bytes = value instanceof Uint8Array ? value : bodyBytes(value);
  const parts = chunks ?? [bytes];
  let index = 0;
  let cancelled = false;
  return {
    status, redirected, type,
    headers: { get(name) { return headers[name.toLowerCase()] ?? null; } },
    body: {
      getReader() {
        return {
          async read() {
            if (cancelled) return { done: true, value: undefined };
            if (index >= parts.length) return { done: true, value: undefined };
            return { done: false, value: parts[index++] };
          },
          async cancel() { cancelled = true; },
        };
      },
    },
  };
}

function session(overrides = {}) {
  const account = overrides.account ?? { id: CONTEXT, structure: 'personal' };
  return {
    user: { id: overrides.principal ?? PRINCIPAL },
    account,
    accessToken: overrides.accessToken ?? jwtFor(account.id),
    ...overrides.fields,
  };
}

function permit(overrides = {}) {
  return {
    operation: 'dispatch',
    permit: {
      permit_id: PERMIT_ID,
      request_kind: 'session_check',
      arguments: {},
      valid_until: new Date(NOW + 60_000).toISOString(),
      ...overrides,
    },
  };
}

function makeCollector(fetchImpl, options = {}) {
  return createBackgroundSetupCollector({ binding, fetchImpl,
    uuid: () => COLLECTOR_ID, wallNow: () => NOW, ...options });
}

test('constructor is inert, validates the fixed binding, and creates a fresh bounded instance id', async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return response(session()); };
  const collector = makeCollector(fetchImpl);
  assert.equal(collector.collectorInstanceId, COLLECTOR_ID);
  assert.equal(fetches, 0);
  assert.throws(() => createBackgroundSetupCollector({ binding: { ...binding, extra: true }, fetchImpl }),
    { code: 'invalid_probe_configuration' });
  assert.throws(() => createBackgroundSetupCollector({ binding: { principal_id: PRINCIPAL, context_id: 'workspace' }, fetchImpl }),
    { code: 'invalid_probe_configuration' });
  assert.throws(() => createBackgroundSetupCollector({ binding: { principal_id: 'bad space', context_id: null }, fetchImpl }),
    { code: 'invalid_probe_configuration' });
});

test('bad permits and body attempts do not consume the one dispatch or fetch', async () => {
  let fetches = 0;
  const collector = makeCollector(async () => { fetches += 1; return response(session()); });
  for (const command of [
    { operation: 'dispatch', permit: { ...permit().permit, request_kind: 'body' } },
    { operation: 'dispatch', permit: { ...permit().permit, arguments: { extra: true } } },
    { operation: 'dispatch', permit: { ...permit().permit, permit_id: 'not-a-uuid' } },
    { operation: 'dispatch', permit: { ...permit().permit, valid_until: new Date(NOW - 1).toISOString() } },
    { operation: 'dispatch', permit: { ...permit().permit, headers: { authorization: 'PRIVATE' } } },
  ]) assert.deepEqual(await collector.call(command), { ok: false, error: { failure_class: 'schema_changed' } });
  assert.deepEqual(await collector.call({ operation: 'pull', sequence: 0 }),
    { ok: false, error: { failure_class: 'aborted' } });
  assert.equal(fetches, 0);
});

test('successful session check returns only canonical identity bytes, supports pull replay, and releases after pull', async () => {
  const requests = [];
  const collector = makeCollector(async (url, options) => {
    requests.push({ url, options });
    return response(session());
  });
  const started = await collector.call(permit());
  const canonical = JSON.stringify({ principal_id: PRINCIPAL, context_id: CONTEXT });
  const bytes = new TextEncoder().encode(canonical);
  assert.deepEqual(started, { ok: true, raw_bytes: bytes.byteLength, chunk_count: 1,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  assert.deepEqual(Object.keys(requests[0].options).sort(),
    ['cache', 'credentials', 'headers', 'method', 'redirect', 'referrerPolicy', 'signal']);
  assert.equal(requests[0].url, 'https://chatgpt.com/api/auth/session');
  assert.deepEqual(requests[0].options.headers, { accept: 'application/json' });
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(requests[0].options.referrerPolicy, 'no-referrer');
  assert.equal(Object.hasOwn(requests[0].options, 'body'), false);
  assert.equal(Object.hasOwn(started, 'token'), false);
  assert.equal(Object.hasOwn(started, 'accessToken'), false);

  assert.deepEqual(await collector.call({ operation: 'release' }),
    { ok: false, error: { failure_class: 'schema_changed' } });
  const chunk = await collector.call({ operation: 'pull', sequence: 0 });
  assert.deepEqual(chunk, {
    ok: true, sequence: 0, decoded_bytes: bytes.byteLength,
    data: Buffer.from(bytes).toString('base64'),
  });
  assert.deepEqual(await collector.call({ operation: 'pull', sequence: 0 }), chunk);
  assert.deepEqual(await collector.call({ operation: 'pull', sequence: 1 }),
    { ok: false, error: { failure_class: 'schema_changed' } });
  assert.deepEqual(await collector.call({ operation: 'release' }), { ok: true });
  assert.deepEqual(await collector.call({ operation: 'pull', sequence: 0 }),
    { ok: false, error: { failure_class: 'aborted' } });
});

test('identity, personal-account, JWT, and session-error checks fail closed without credentials', async () => {
  const cases = [
    { principal: 'other-principal', expected: 'identity_mismatch' },
    { account: { id: CONTEXT, structure: 'workspace' }, expected: 'identity_mismatch' },
    { accessToken: 'not-a-jwt', expected: 'identity_mismatch' },
    { accessToken: jwtFor('other-account'), expected: 'identity_mismatch' },
    { accessToken: jwtFor(CONTEXT, NOW / 1000 - 1), expected: 'identity_mismatch' },
    { fields: { error: 'session-error' }, expected: 'schema_changed' },
    { fields: { workspaceTokenExchangeError: 'exchange-error' }, expected: 'schema_changed' },
  ];
  for (const item of cases) {
    const collector = makeCollector(async () => response(session(item)));
    const result = await collector.call(permit());
    assert.deepEqual(result, { ok: false, error: { failure_class: item.expected } });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|TOKEN|COOKIE|email|accessToken/);
  }
});

test('content, redirect, UTF-8, schema, and raw-size failures are bounded', async () => {
  const cases = [
    () => response(session(), { headers: {} }),
    () => response(session(), { redirected: true }),
    () => response(session(), { type: 'opaqueredirect' }),
    () => response(new Uint8Array([0xff, 0xfe])),
    () => response('[]'),
    () => response(new Uint8Array(16 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
  ];
  for (const makeResponse of cases) {
    const collector = makeCollector(async () => makeResponse());
    assert.deepEqual(await collector.call(permit()),
      { ok: false, error: { failure_class: 'schema_changed' } });
  }
});

test('status failures preserve fixed classification and bounded Retry-After', async () => {
  for (const [status, expected] of [[401, 'auth_required'], [403, 'challenge']]) {
    const collector = makeCollector(async () => response('', { status, headers: {} }));
    assert.deepEqual(await collector.call(permit()), {
      ok: false, error: { failure_class: expected, http_status: status },
    });
  }
  const rateLimited = makeCollector(async () => response('', {
    status: 429, headers: { 'retry-after': '3600' },
  }));
  assert.deepEqual(await rateLimited.call(permit()), {
    ok: false, error: { failure_class: 'rate_limited', http_status: 429, retry_after: '3600' },
  });
  const malformed = makeCollector(async () => response('', {
    status: 429, headers: { 'retry-after': 'PRIVATE\nSENTINEL' },
  }));
  const result = await malformed.call(permit());
  assert.deepEqual(result, {
    ok: false, error: { failure_class: 'rate_limited', http_status: 429, retry_after: 'invalid' },
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SENTINEL/);
});

test('deadline settles a fetch that ignores AbortSignal, and dispose aborts without a second fetch', async () => {
  let fetches = 0;
  let signal;
  const pending = makeCollector(async (_url, options) => {
    fetches += 1;
    signal = options.signal;
    return new Promise(() => {});
  }, { timeoutMs: 5 });
  assert.deepEqual(await pending.call(permit()),
    { ok: false, error: { failure_class: 'timeout' } });
  assert.equal(fetches, 1);
  assert.equal(signal.aborted, true);

  let releaseFetch;
  const aborting = makeCollector(async (_url, options) => {
    fetches += 1;
    options.signal.addEventListener('abort', () => releaseFetch?.());
    return new Promise(() => {});
  }, { timeoutMs: 30000 });
  const call = aborting.call(permit({ permit_id: BOUNDARY_ID }));
  await new Promise((resolve) => setImmediate(resolve));
  const disposed = aborting.dispose();
  releaseFetch = () => {};
  assert.deepEqual(await disposed, { ok: true });
  assert.deepEqual(await call, { ok: false, error: { failure_class: 'aborted' } });
  assert.deepEqual(await aborting.dispose(), { ok: true });
  assert.equal(fetches, 2);
});

test('hung reader drops raw chunks and remains bounded when cancellation is ignored', async () => {
  const raw = bodyBytes(session());
  let fetches = 0;
  let cancelCalls = 0;
  const hangingResponse = () => {
    let reads = 0;
    return {
      status: 200,
      headers: { get: () => 'application/json' },
      body: { getReader: () => ({
        async read() {
          if (reads++ === 0) return { done: false, value: raw };
          return new Promise(() => {});
        },
        cancel() { cancelCalls += 1; return new Promise(() => {}); },
      }) },
    };
  };
  const timed = makeCollector(async () => { fetches += 1; return hangingResponse(); }, { timeoutMs: 5 });
  assert.deepEqual(await timed.call(permit()), { ok: false, error: { failure_class: 'timeout' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await timed.call({ operation: 'pull', sequence: 0 }),
    { ok: false, error: { failure_class: 'aborted' } });

  const disposed = makeCollector(async () => { fetches += 1; return hangingResponse(); }, { timeoutMs: 30000 });
  const pending = disposed.call(permit({ permit_id: BOUNDARY_ID }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await disposed.dispose(), { ok: true });
  assert.deepEqual(await pending, { ok: false, error: { failure_class: 'aborted' } });
  assert.deepEqual(await disposed.call({ operation: 'pull', sequence: 0 }),
    { ok: false, error: { failure_class: 'aborted' } });
  assert.equal(fetches, 2);
  assert.equal(cancelCalls, 2);
});

test('concurrent dispatch is rejected and all returned failures remain allowlisted', async () => {
  let resolveFetch;
  const collector = makeCollector(async () => new Promise((resolve) => { resolveFetch = resolve; }));
  const first = collector.call(permit());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await collector.call(permit({ permit_id: BOUNDARY_ID })),
    { ok: false, error: { failure_class: 'schema_changed' } });
  resolveFetch(response(session()));
  assert.equal((await first).ok, true);
  const after = await collector.call(permit({ permit_id: BOUNDARY_ID }));
  assert.ok(['schema_changed', 'aborted'].includes(after.error?.failure_class));
});
