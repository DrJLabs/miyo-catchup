import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createBackgroundSelectedCollector } from '../extension/background-selected-collector.mjs';

const NOW = 1700000000000;
const binding = { principal_id: 'synthetic-principal', context_id: 'synthetic-personal' };
const conversationId = 'synthetic-selected';
const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
function session(overrides = {}) {
  return { user: { id: binding.principal_id }, account: { id: binding.context_id, structure: 'personal' },
    accessToken: `${encode({ alg: 'synthetic' })}.${encode({ exp: NOW / 1000 + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: binding.context_id }, sentinel: 'PRIVATE_TOKEN_SENTINEL' })}.signature`,
    cookie: 'PRIVATE_COOKIE_SENTINEL', ...overrides };
}
function body(text = 'Synthetic 雪🌿') {
  return { conversation_id: conversationId, title: 'Synthetic', create_time: 1, update_time: 2,
    current_node: 'message', mapping: {
      root: { id: 'root', parent: null, children: ['message'], message: null },
      message: { id: 'message', parent: 'root', children: [], message: {
        id: 'message', author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] },
      } },
    } };
}
function response(value, { status = 200, headers = {}, chunk = 8191 } = {}) {
  const bytes = value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value));
  let offset = 0;
  return { status, headers: { get: (name) => headers[name] ?? (name === 'content-type' ? 'application/json' : null) },
    body: { getReader: () => ({
      async read() {
        if (offset === bytes.length) return { done: true };
        const value = bytes.subarray(offset, offset + chunk); offset += value.length;
        return { done: false, value };
      }, async cancel() {},
    }) } };
}
function harness(t, options = {}) {
  let wall = NOW; let mono = 1000;
  const requests = [];
  const collector = createBackgroundSelectedCollector({ binding, conversationId,
    wallNow: () => wall, monotonicNow: () => mono, fetchImpl: async (url, init) => {
      requests.push({ url, ...init });
      return response(url.endsWith('/session') ? session() : body());
    }, ...options });
  t.after(() => collector.dispose());
  const permit = (kind = 'session_check', extra = {}) => ({ operation: 'dispatch', permit: {
    permit_id: randomUUID(), request_kind: kind, valid_until: new Date(wall + 5000).toISOString(),
    arguments: kind === 'body' ? { conversation_ids: [conversationId] } : {}, ...extra,
  } });
  return { collector, requests, permit,
    advance(ms, wallExtra = 0) { wall += ms + wallExtra; mono += ms; } };
}
async function drain(collector, result, release = true) {
  assert.equal(result.ok, true);
  const chunks = [];
  for (let n = 0; n < result.chunk_count; n++) {
    const chunk = await collector.call({ operation: 'pull', sequence: n });
    assert.equal(chunk.ok, true);
    assert.ok(chunk.decoded_bytes <= 184320);
    chunks.push(Buffer.from(chunk.data, 'base64'));
  }
  if (release) assert.deepEqual(await collector.call({ operation: 'release' }), { ok: true });
  return Buffer.concat(chunks);
}
async function ready(h) {
  const result = await h.collector.call(h.permit());
  const bytes = await drain(h.collector, result);
  assert.equal(bytes.toString(), JSON.stringify(binding));
  h.advance(10000);
}

test('selected constructor and invalid permits never issue a fetch', async (t) => {
  const h = harness(t);
  assert.equal(h.requests.length, 0);
  assert.throws(() => createBackgroundSelectedCollector({ binding: { ...binding, context_id: null }, conversationId }));
  for (const command of [h.permit('body'), h.permit('catalog'), h.permit('session_check', { arguments: { url: 'bad' } }),
    h.permit('session_check', { valid_until: new Date(NOW - 1).toISOString() })]) {
    assert.equal((await h.collector.call(command)).ok, false);
  }
  assert.equal(h.requests.length, 0);
});

test('one fresh session then cookie-free GET, exact bytes, bounded chunks, no credential output or retry', async (t) => {
  const raw = Buffer.from(JSON.stringify(body('雪🌿'.repeat(100000)), null, 2));
  const requests = [];
  const h = harness(t, { fetchImpl: async (url, init) => {
    requests.push({ url, ...init }); return response(requests.length === 1 ? session() : raw);
  } });
  await ready(h);
  const p = h.permit('body');
  const result = await h.collector.call(p);
  assert.equal(result.ok, true);
  assert.ok(result.chunk_count > 1);
  const first = await h.collector.call({ operation: 'pull', sequence: 0 });
  assert.deepEqual(await h.collector.call({ operation: 'pull', sequence: 0 }), first);
  assert.equal((await h.collector.call({ operation: 'release' })).ok, false);
  assert.equal((await h.collector.call({ operation: 'pull', sequence: 2 })).ok, false);
  const received = await drain(h.collector, result);
  assert.deepEqual(received, raw);
  assert.equal(result.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(requests[0].credentials, 'include');
  assert.equal(requests[1].url, `https://chatgpt.com/backend-api/conversation/${conversationId}`);
  assert.equal(requests[1].method, 'GET');
  assert.equal(requests[1].credentials, 'omit');
  assert.equal(requests[1].headers.authorization, `Bearer ${session().accessToken}`);
  assert.deepEqual(Object.keys(requests[1].headers).sort(), ['accept', 'authorization']);
  assert.equal(requests[1].redirect, 'error');
  assert.equal(requests[1].cache, 'no-store');
  assert.equal(requests[1].referrerPolicy, 'no-referrer');
  assert.equal((await h.collector.call(p)).ok, false);
  assert.equal((await h.collector.call(h.permit())).ok, false);
  assert.equal(requests.length, 2);
  assert.ok(!received.toString().includes('PRIVATE_'));
});

test('context, principal, account type and token scope failures never reach the body route', async (t) => {
  for (const value of [session({ user: { id: 'wrong' } }), session({ account: { id: 'wrong', structure: 'personal' } }),
    session({ account: { id: binding.context_id, structure: 'workspace' } }), session({ accessToken: 'invalid' })]) {
    let calls = 0;
    const h = harness(t, { fetchImpl: async () => { calls++; return response(value); } });
    assert.equal((await h.collector.call(h.permit())).ok, false);
    h.advance(10000);
    assert.equal((await h.collector.call(h.permit('body'))).ok, false);
    assert.equal(calls, 1);
  }
});

test('session release, spacing, exact selection and distinct permits gate body dispatch', async (t) => {
  const h = harness(t);
  const p = h.permit();
  const result = await h.collector.call(p);
  h.advance(10000);
  assert.equal((await h.collector.call(h.permit('body'))).ok, false);
  await drain(h.collector, result);
  for (const extra of [{ permit_id: p.permit.permit_id }, { arguments: { conversation_ids: ['wrong'] } },
    { arguments: { conversation_ids: [conversationId, 'extra'] } }]) {
    assert.equal((await h.collector.call(h.permit('body', extra))).ok, false);
  }
  assert.equal(h.requests.length, 1);
  const early = harness(t);
  await drain(early.collector, await early.collector.call(early.permit()));
  assert.equal((await early.collector.call(early.permit('body'))).ok, false);
  assert.equal(early.requests.length, 1);
});

test('token age, expiry and clock discontinuity block without refreshing or fetching body', async (t) => {
  for (const [advance, extra] of [[61000, 0], [10000, -2000], [10000, 2000]]) {
    const h = harness(t);
    await drain(h.collector, await h.collector.call(h.permit()));
    h.advance(advance, extra);
    assert.equal((await h.collector.call(h.permit('body'))).ok, false);
    assert.equal(h.requests.length, 1);
  }
});

test('wrong ID, malformed UTF8, auth envelopes and oversized body stop before transfer', async (t) => {
  for (const invalid of [{ ...body(), conversation_id: 'wrong' }, { ...body(), accessToken: 'PRIVATE' },
    ...['token', 'credentials', 'Authorization', 'ACCESS_TOKEN', 'Refresh-Token', 'CookieJar', 'api_key']
      .map((key) => ({ ...body(), [key]: 'PRIVATE_ENVELOPE_SENTINEL' })),
    Uint8Array.of(255), new Uint8Array(64 * 1024 * 1024 + 1)]) {
    let calls = 0;
    const h = harness(t, { fetchImpl: async () => response(++calls === 1 ? session() : invalid,
      { chunk: invalid instanceof Uint8Array ? invalid.length : 8191 }) });
    await ready(h);
    assert.equal((await h.collector.call(h.permit('body'))).ok, false);
    assert.equal((await h.collector.call({ operation: 'pull', sequence: 0 })).ok, false);
    assert.equal((await h.collector.call(h.permit('body'))).ok, false);
    assert.equal(calls, 2);
  }
});

test('429/auth/challenge/redirect-like failures never trigger token refresh, cookie fallback or retries', async (t) => {
  for (const [status, expected] of [[429, 'rate_limited'], [401, 'auth_required'], [403, 'challenge'], [302, 'schema_changed']]) {
    let calls = 0;
    const h = harness(t, { fetchImpl: async () => ++calls === 1 ? response(session())
      : response({}, { status, headers: { 'retry-after': '7200' } }) });
    await ready(h);
    const result = await h.collector.call(h.permit('body'));
    assert.equal(result.error.failure_class, expected);
    if (status === 429) assert.equal(result.error.retry_after, '7200');
    assert.equal((await h.collector.call(h.permit('body'))).ok, false);
    assert.equal(calls, 2);
  }
});

test('hung body fetch/read and ignored abort settle, clear output and stay terminal', async (t) => {
  for (const hang of ['fetch', 'read']) {
    let calls = 0;
    const h = harness(t, { timeoutMs: 10, fetchImpl: async () => {
      if (++calls === 1) return response(session());
      if (hang === 'fetch') return new Promise(() => {});
      return { status: 200, headers: { get: () => 'application/json' }, body: { getReader: () => ({
        read: () => new Promise(() => {}), cancel: () => new Promise(() => {}),
      }) } };
    } });
    await ready(h);
    assert.equal((await h.collector.call(h.permit('body'))).error.failure_class, 'timeout');
    await h.collector.dispose();
    assert.equal((await h.collector.call({ operation: 'pull', sequence: 0 })).ok, false);
    assert.equal(calls, 2);
  }
});

test('rejected status and content type cancel unread response streams before releasing ownership', async (t) => {
  for (const [status, contentType] of [[429, 'application/json'], [401, 'application/json'], [200, 'text/html']]) {
    let calls = 0; let cancelled = 0; let signal;
    const h = harness(t, { fetchImpl: async (_url, init) => {
      if (++calls === 1) return response(session());
      signal = init.signal;
      return new Response(new ReadableStream({ cancel() { cancelled++; } }),
        { status, headers: { 'content-type': contentType } });
    } });
    await ready(h);
    assert.equal((await h.collector.call(h.permit('body'))).ok, false);
    await h.collector.dispose();
    assert.equal(cancelled, 1);
    assert.equal(signal.aborted, true);
    assert.equal(calls, 2);
  }
});
