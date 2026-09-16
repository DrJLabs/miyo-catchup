import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  MAX_MESSAGE_BYTES, MAX_RAW_CHUNK_BYTES, REQUEST_OPERATIONS, COUNT_KEYS,
  assertRequest, validateIdentityBinding, validateReceipt, validateReply,
  validateRequest, validateStatus
} from '../src/contracts.mjs';
import { DEFAULT_LIMITS, assertValidConfig, validateConfig } from '../src/config.mjs';
import { schemaConforms } from './helpers/schema-check.mjs';

const documents = Object.fromEntries(['protocol', 'status', 'receipt', 'config'].map((name) => {
  const file = `${name}-v1.json`;
  return [file, JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url)))];
}));
const conforms = (name, value) => schemaConforms(documents[`${name}-v1.json`], value, { documents });

const u = () => randomUUID();
const base = (operation, payload, fields = {}) => ({ protocol_version: 1, request_id: u(), operation, payload, ...fields });
const runFields = { run_id: u(), attempt_id: u(), lease_generation: 0 };
const permitFields = { ...runFields, permit_id: u() };

function requests() {
  return {
    hello: base('hello', { extension_version: '1.0.0', browser_instance_id: u(), capabilities: ['session_check', 'catalog', 'body', 'chunking'] }),
    request_run: base('request_run', { trigger_type: 'manual', mode: 'publish', idempotency_key: u() }),
    get_status: base('get_status', {}),
    claim_work: base('claim_work', { browser_instance_id: u(), principal_id: null, context_id: null }),
    request_permit: base('request_permit', { work_unit_id: 'body:conversation-1' }, runFields),
    dispatch_started: base('dispatch_started', { browser_instance_id: u(), document_id: 'document-1' }, permitFields),
    result_chunk: base('result_chunk', { sequence: 0, decoded_bytes: 3, data: Buffer.from('abc').toString('base64') }, permitFields),
    commit_result: base('commit_result', { chunk_count: 1, raw_bytes: 3, sha256: createHash('sha256').update('abc').digest('hex') }, permitFields),
    request_failed: base('request_failed', { failure_class: 'rate_limited', http_status: 429, retry_after: 'Wed, 21 Oct 2015 07:28:00 GMT' }, permitFields),
    reconcile_dispatch: base('reconcile_dispatch', { browser_instance_id: u(), document_id: 'document-1', outcome: 'settled' }, permitFields),
    pause: base('pause', {}, { run_id: u() }),
    resume: base('resume', {}, { run_id: u() }),
    verify: base('verify', {}, { run_id: u() })
  };
}

function config() {
  return {
    config_version: 1,
    binding: { binding_id: 'binding-1', principal_id: 'principal-1', context_id: 'personal-default', account_id: 'account-1' },
    roots: {
      release_root: '/tmp/miyo/releases', extension_root: '/tmp/miyo/extension', native_host_root: '/tmp/miyo/native',
      state_root: '/tmp/miyo/state', runtime_root: '/tmp/miyo/runtime', miyo_chats_root: '/tmp/miyo/chats', miyo_manifest_path: '/tmp/miyo/manifest.json'
    },
    versions: { worker: '1.0.0', extension: '1.0.0', protocol: 1, config: 1, release_sha256: 'd'.repeat(64), chatgpt_adapter: 'a'.repeat(64), miyo_adapter: 'b'.repeat(64), renderer: 'c'.repeat(64) },
    schedule: { enabled: false, timezone: 'America/New_York', local_time: '04:00', persistent: true, randomized_delay_seconds: 600, accuracy_seconds: 60 },
    limits: { ...DEFAULT_LIMITS },
    state: { namespace: 'daily', owner: 'miyo-chatgpt-catchup' }
  };
}

test('all allowlisted request operations validate', () => {
  const values = requests();
  assert.deepEqual(Object.keys(values).sort(), [...REQUEST_OPERATIONS].sort());
  for (const [operation, message] of Object.entries(values)) {
    assert.equal(validateRequest(message).ok, true, `${operation}: ${validateRequest(message).errors}`);
    assert.equal(conforms('protocol', message), true, operation);
    for (const mutated of [{ ...message, extra: true }, { ...message, protocol_version: 99 }, { ...message, payload: { ...message.payload, extra: true } }]) {
      assert.equal(validateRequest(mutated).ok, false, operation);
      assert.equal(conforms('protocol', mutated), false, operation);
    }
  }
});

test('request validators reject unknown fields, versions, malformed IDs and sensitive data', () => {
  const message = requests().hello;
  assert.equal(validateRequest({ ...message, protocol_version: 2 }).ok, false);
  assert.equal(validateRequest({ ...message, request_id: 'not-an-id' }).ok, false);
  assert.equal(validateRequest({ ...message, unexpected: true }).ok, false);
  assert.equal(validateRequest({ ...message, payload: { ...message.payload, authorization: 'Bearer secret' } }).ok, false);
  assert.equal(validateRequest({ ...message, payload: { ...message.payload, extension_version: '1.0' } }).ok, false);
  assert.equal(validateRequest({ ...requests().result_chunk, payload: { sequence: 0, decoded_bytes: 1, data: '!!!' } }).ok, false);
  assert.equal(validateRequest({ ...requests().commit_result, payload: { chunk_count: 1, raw_bytes: Number.MAX_SAFE_INTEGER + 1, sha256: '0'.repeat(64) } }).ok, false);
  assert.doesNotMatch(validateRequest({ ...message, payload: { ...message.payload, token: 'sensitive-value' } }).errors.join(' '), /sensitive-value/);
});

test('background session capability and collector identity are strict additive wire variants', () => {
  const hello = requests().hello;
  hello.payload.capabilities = ['session_check', 'chunking', 'background_session_check'];
  assert.equal(validateRequest(hello).ok, true);
  assert.equal(conforms('protocol', hello), true);
  const dispatch = requests().dispatch_started;
  dispatch.payload = { browser_instance_id: u(), collector_instance_id: u() };
  assert.equal(validateRequest(dispatch).ok, true);
  assert.equal(conforms('protocol', dispatch), true);
  const reconcile = requests().reconcile_dispatch;
  reconcile.payload = { browser_instance_id: u(), collector_instance_id: u(), outcome: 'settled' };
  assert.equal(validateRequest(reconcile).ok, true);
  assert.equal(conforms('protocol', reconcile), true);
  for (const payload of [
    { browser_instance_id: u() },
    { browser_instance_id: u(), document_id: 'document-1', collector_instance_id: u() },
  ]) {
    assert.equal(validateRequest({ ...dispatch, payload }).ok, false);
    assert.equal(conforms('protocol', { ...dispatch, payload }), false);
  }
  assert.equal(validateRequest({ ...hello, payload: { ...hello.payload, capabilities: ['background_session_check'] } }).ok, true);
});

test('SemVer fixtures agree across config, hello, and status contracts', () => {
  const valid = ['0.0.0', '1.0.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-0.alpha', '1.0.0--alpha', '1.0.0-rc.1+build.2', '1.0.0+01'];
  const invalid = ['01.0.0', '1.01.0', '1.0.01', '1.0.0-alpha..1', '1.0.0-01', '1.0.0-rc.01', '1.0.0-', '1.0.0+build..2', '1.0.0+build+other', '1.0.0\n', '1.0.0 ', ' 1.0.0'];
  for (const version of valid) {
    const hello = requests().hello;
    hello.payload.extension_version = version;
    assert.equal(validateRequest(hello).ok, true, `hello ${version}`);
    assert.equal(conforms('protocol', hello), true, `hello ${version}`);
    const status = statusFixture();
    status.worker_version = version;
    assert.equal(validateStatus(status).ok, true, `status ${version}`);
    assert.equal(conforms('status', status), true, `status ${version}`);
  }
  for (const version of invalid) {
    const hello = requests().hello;
    hello.payload.extension_version = version;
    assert.equal(validateRequest(hello).ok, false, `hello ${version}`);
    assert.equal(conforms('protocol', hello), false, `hello ${version}`);
    const status = statusFixture();
    status.worker_version = version;
    assert.equal(validateStatus(status).ok, false, `status ${version}`);
    assert.equal(conforms('status', status), false, `status ${version}`);
  }
});

test('reply result validators cover success and sanitized failure replies', () => {
  const id = u();
  const ok = (result) => {
    const reply = { protocol_version: 1, request_id: id, ok: true, result };
    assert.equal(conforms('protocol', reply), true, JSON.stringify(result));
    return reply;
  };
  assert.equal(validateReply(ok({ worker_instance_id: u(), protocol_version: 1, config_version: 1 }), 'hello').ok, true);
  assert.equal(validateReply(ok({ run_id: u(), state: 'queued', coalesced: false, blocked: false }), 'request_run').ok, true);
  assert.equal(validateReply(ok({ lease: null }), 'claim_work').ok, true);
  assert.equal(validateReply(ok({ lease: { ...runFields, lease_expires_at: '2026-09-15T00:00:00Z', work_unit: 'synthetic-work' } }), 'claim_work').ok, true);
  assert.equal(validateReply(ok({ status: statusFixture() }), 'get_status').ok, true);
  assert.equal(validateReply(ok({ granted: false, denial_code: 'busy' }), 'request_permit').ok, true);
  for (const [request_kind, args] of Object.entries({ session_check: {}, body: { conversation_ids: ['conversation-1'] }, catalog: { cursor: null } })) {
    assert.equal(validateReply(ok({ granted: true, permit_id: u(), request_kind, arguments: args, valid_until: '2026-09-15T00:00:00Z' }), 'request_permit').ok, true);
  }
  assert.equal(validateReply(ok({ accepted: true }), 'dispatch_started').ok, true);
  assert.equal(validateReply(ok({ next_sequence: 1 }), 'result_chunk').ok, true);
  assert.equal(validateReply(ok({ artifact_id: u(), raw_bytes: 3, sha256: '0'.repeat(64) }), 'commit_result').ok, true);
  assert.equal(validateReply(ok({ recorded: true }), 'request_failed').ok, true);
  assert.equal(validateReply(ok({ state: 'settled' }), 'reconcile_dispatch').ok, true);
  assert.equal(validateReply(ok({ state: 'pause_requested' }), 'pause').ok, true);
  assert.equal(validateReply(ok({ state: 'resumed' }), 'resume').ok, true);
  assert.equal(validateReply(ok({ status: 'verified' }), 'verify').ok, true);
  assert.equal(validateReply({ protocol_version: 1, request_id: id, ok: false, error: { code: 'cooldown', retry_at: '2026-09-15T00:00:00Z' } }).ok, true);
  assert.equal(validateReply({ protocol_version: 1, request_id: id, ok: true, result: { message: 'raw remote error' } }, 'hello').ok, false);
  assert.equal(validateReply({ protocol_version: 1, request_id: id, ok: false, error: { code: 'internal', raw_error: 'secret' } }).ok, false);
});

test('config requires explicit binding, pinned roots/fingerprints, disabled schedule and all literal limits', () => {
  const value = config();
  assert.equal(validateConfig(value).ok, true);
  assert.deepEqual(assertValidConfig(value), value);
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const changed = config(); changed.limits[key] += 1;
    assert.equal(validateConfig(changed).ok, false, key);
  }
  for (const mutation of [
    (x) => { delete x.binding.account_id; },
    (x) => { x.schedule.enabled = true; },
    (x) => { x.versions.chatgpt_adapter = 'not-a-fingerprint'; },
    (x) => { x.roots.state_root = 'relative/state'; },
    (x) => { x.extra = true; },
    (x) => { x.limits.max_message_bytes = Number.POSITIVE_INFINITY; }
  ]) { const changed = config(); mutation(changed); assert.equal(validateConfig(changed).ok, false); }
});

function statusFixture() {
  return {
    status_version: 1, generated_at: '2026-09-15T00:00:00Z', worker_instance_id: u(), worker_version: '0.0.0',
    heartbeat_at: '2026-09-15T00:00:00Z', connectivity: 'available', liveness: 'live',
    run: { run_id: u(), attempt_id: null, mode: 'publish', trigger_type: 'manual', stage: 'queued', resume_stage: null,
      scan: { generation: 0, started_at: null, ended_at: null, coverage: null }, progress: Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])) },
    blockers: [], primary_blocker: null, pause_requested: false, paused_at_safe_boundary: false,
    last_complete_scan: null, last_fully_verified_run: null, receipt_evidence_at: null, next_scheduled_due_at: null,
    cooldown_until: null, retry_at: null, budget_remaining: { session_requests: 5, catalog_pages: 300, body_requests: 200, total_requests: 505, attempts: 3 }, error_code: null,
  };
}
test('status and receipt validators reject version drift and excess fields', () => {
  const status = statusFixture();
  assert.equal(validateStatus(status).ok, true);
  assert.equal(conforms('status', status), true);
  assert.equal(validateStatus({ ...status, status_version: 2 }).ok, false);
  assert.equal(validateStatus({ ...status, run: { ...status.run, progress: { ...status.run.progress, token: 1 } } }).ok, false);
  for (const key of Object.keys(status)) {
    const missing = structuredClone(status); delete missing[key];
    assert.equal(validateStatus(missing).ok, false, key);
    assert.equal(conforms('status', missing), false, key);
  }
  const receipt = { receipt_version: 1, receipt_id: u(), request_id: u(), run_id: u(), attempt_id: u(), operation: 'commit_result', outcome: 'committed', observed_at: '2026-09-15T00:00:00Z', artifact: { artifact_id: u(), raw_bytes: 3, sha256: '0'.repeat(64) } };
  assert.equal(validateReceipt(receipt).ok, true);
  assert.equal(conforms('receipt', receipt), true);
  const acceptedCommit = { ...receipt, outcome: 'accepted' };
  delete acceptedCommit.artifact;
  assert.equal(validateReceipt(acceptedCommit).ok, false);
  assert.equal(conforms('receipt', acceptedCommit), false);
  const failedCommit = { ...acceptedCommit, outcome: 'failed', failure_code: 'internal' };
  assert.equal(validateReceipt(failedCommit).ok, true);
  assert.equal(conforms('receipt', failedCommit), true);
  assert.equal(validateReceipt({ ...receipt, receipt_version: 2 }).ok, false);
  assert.equal(validateReceipt({ ...receipt, authorization: 'secret' }).ok, false);
});

test('boundaries reject executable getters, excessive depth, unsafe numbers and diagnostic key leakage', () => {
  for (const validator of [validateRequest, validateStatus, validateReceipt, validateConfig]) {
    let calls = 0;
    const value = { get private_key() { calls += 1; throw new Error('SECRET'); } };
    assert.equal(validator(value).ok, false);
    assert.equal(calls, 0);
    assert.doesNotMatch(validator({ PRIVATE_SENTINEL: { value: Infinity } }).errors.join(' '), /PRIVATE_SENTINEL/);
    const cyclic = {}; cyclic.value = cyclic;
    assert.equal(validator(cyclic).ok, false);
  }
});

test('daily identity key and session bootstrap are expressible without inventing attestation', () => {
  const daily = base('request_run', { trigger_type: 'daily', mode: 'publish', idempotency_key: { binding_id: 'binding-1', timezone: 'America/New_York', due_date: '2026-09-15' } });
  assert.equal(validateRequest(daily).ok, true);
  assert.equal(conforms('protocol', daily), true);
  const bootstrap = requests().claim_work;
  assert.equal(validateRequest(bootstrap).ok, true);
  bootstrap.payload.principal_id = 'principal-1';
  assert.equal(validateRequest(bootstrap).ok, false);
  assert.equal(conforms('protocol', bootstrap), false);
  const manual = requests().request_run; manual.payload.idempotency_key = 'not-a-uuid';
  assert.equal(validateRequest(manual).ok, false);
  assert.equal(conforms('protocol', manual), false);
});

test('invalid Retry-After remains reportable so a 429 cannot lose its conservative cooldown', () => {
  for (const retry_after of ['7200', 'Wed, 21 Oct 2015 07:28:00 GMT', '', 'invalid', '9'.repeat(128)]) {
    const message = requests().request_failed; message.payload.retry_after = retry_after;
    assert.equal(validateRequest(message).ok, true);
    assert.equal(conforms('protocol', message), true);
  }
});

test('reply results are closed and tied to a known request operation', () => {
  const reply = (result) => ({ protocol_version: 1, request_id: u(), ok: true, result });
  for (const [operation, result] of [
    ['get_status', { status: { x: 1 } }],
    ['request_permit', { granted: true, permit_id: u(), request_kind: 'body', arguments: {}, valid_until: '2026-09-15T00:00:00Z' }],
    ['request_permit', { granted: true, permit_id: u(), request_kind: 'session_check', arguments: { command: 'anything' }, valid_until: '2026-09-15T00:00:00Z' }],
    ['request_permit', { granted: false }],
  ]) {
    const value = reply(result);
    assert.equal(validateReply(value, operation).ok, false);
    assert.equal(conforms('protocol', value), false);
  }
  const value = reply({ accepted: true });
  assert.equal(validateReply(value).ok, false);
  assert.equal(validateReply(value, 'bogus').ok, false);
  assert.equal(validateReply({ ...value, error: { code: 'internal' } }, 'dispatch_started').ok, false);
  assert.equal(conforms('protocol', { ...value, error: { code: 'internal' } }), false);
});

test('status cannot mask disconnection, paused cooldown, partial scans or invalid progress as verified', () => {
  for (const change of [
    (s) => { s.connectivity = 'unavailable'; },
    (s) => { s.heartbeat_at = '2026-09-14T00:00:00Z'; },
    (s) => { s.run.progress.selected = 1; s.run.progress.selected_new = 1; s.run.progress.verified = 1; s.run.progress.indexed = 0; },
    (s) => { s.run.progress.selected = 1; s.run.progress.selected_new = 1; s.run.progress.indexed = 2; },
    (s) => { s.run.stage = 'verified'; },
    (s) => { s.run.progress.published = 1; },
    (s) => { s.run.mode = 'dry_run'; s.run.stage = 'verified'; },
    (s) => { s.primary_blocker = 'cooldown'; },
  ]) { const s = statusFixture(); change(s); assert.equal(validateStatus(s).ok, false); }
  const paused = statusFixture();
  Object.assign(paused, { pause_requested: true, paused_at_safe_boundary: true, blockers: ['cooldown'], primary_blocker: 'cooldown', cooldown_until: '2026-09-15T01:00:00Z' });
  assert.equal(validateStatus(paused).ok, true);
  assert.equal(conforms('status', paused), true);
});

test('status liveness uses strict heartbeat boundaries and preserves independent connectivity', () => {
  const staleFresh = statusFixture();
  staleFresh.liveness = 'stale';
  assert.equal(validateStatus(staleFresh).ok, false);

  const staleAtBoundary = statusFixture();
  staleAtBoundary.liveness = 'stale';
  staleAtBoundary.heartbeat_at = '2026-09-14T23:58:30Z';
  assert.equal(validateStatus(staleAtBoundary).ok, false);

  const stale = statusFixture();
  stale.liveness = 'stale';
  stale.heartbeat_at = '2026-09-14T23:58:29.999Z';
  assert.equal(validateStatus(stale).ok, true);

  const staleWithoutHeartbeat = statusFixture();
  staleWithoutHeartbeat.liveness = 'stale';
  staleWithoutHeartbeat.heartbeat_at = null;
  assert.equal(validateStatus(staleWithoutHeartbeat).ok, false);

  for (const key of ['worker_instance_id', 'worker_version']) {
    const staleWithoutIdentity = structuredClone(stale);
    staleWithoutIdentity[key] = null;
    assert.equal(validateStatus(staleWithoutIdentity).ok, false);
  }

  const liveAtBoundary = statusFixture();
  liveAtBoundary.heartbeat_at = '2026-09-14T23:58:30Z';
  assert.equal(validateStatus(liveAtBoundary).ok, true);

  const liveOld = statusFixture();
  liveOld.heartbeat_at = '2026-09-14T23:58:29.999Z';
  assert.equal(validateStatus(liveOld).ok, false);

  const future = statusFixture();
  future.heartbeat_at = '2026-09-15T00:00:00.001Z';
  assert.equal(validateStatus(future).ok, false);
  future.liveness = 'stale';
  assert.equal(validateStatus(future).ok, false);

  const reachableButUnavailable = statusFixture();
  reachableButUnavailable.liveness = 'unavailable';
  assert.equal(validateStatus(reachableButUnavailable).ok, false);

  const disconnected = structuredClone(stale);
  disconnected.connectivity = 'unavailable';
  disconnected.liveness = 'unavailable';
  assert.equal(validateStatus(disconnected).ok, true);
  disconnected.worker_instance_id = null;
  disconnected.worker_version = null;
  disconnected.heartbeat_at = null;
  assert.equal(validateStatus(disconnected).ok, true);
});

test('verified status requires every selected item to be indexed', () => {
  const complete = statusFixture();
  complete.run.stage = 'verified';
  complete.run.scan = { generation: 1, started_at: '2026-09-15T00:00:00Z', ended_at: '2026-09-15T00:01:00Z', coverage: 'qualified_catalog_only' };
  Object.assign(complete.run.progress, { selected: 1, selected_new: 1, downloaded: 1, fetched: 1, staged: 1, published: 1, indexed: 1, verified: 1 });
  assert.equal(validateStatus(complete).ok, true);
  assert.equal(conforms('status', complete), true);

  const notIndexed = structuredClone(complete);
  notIndexed.run.progress.indexed = 0;
  assert.equal(validateStatus(notIndexed).ok, false);
  assert.equal(conforms('status', notIndexed), true);

  const overIndexed = structuredClone(complete);
  overIndexed.run.progress.indexed = 2;
  assert.equal(validateStatus(overIndexed).ok, false);
});

test('schema files are versioned strict JSON without dependencies', () => {
  for (const name of ['config-v1.json', 'protocol-v1.json', 'status-v1.json', 'receipt-v1.json']) {
    const schema = JSON.parse(readFileSync(new URL(`../schemas/${name}`, import.meta.url)));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(typeof schema.$id, 'string');
    assert.ok(!schema.$ref || !schema.$ref.startsWith('http'));
  }
  assert.equal(MAX_MESSAGE_BYTES, 262144);
  assert.equal(MAX_RAW_CHUNK_BYTES, 184320);
});

test('identity assertion requires exact principal/context and a nonblank account', () => {
  const binding = { binding_id: 'b', principal_id: 'p', context_id: 'c', account_id: 'a' };
  assert.equal(validateIdentityBinding(binding, { principal_id: 'p', context_id: 'c', account_id: 'a' }).ok, true);
  assert.equal(validateIdentityBinding(binding, { principal_id: 'other', context_id: 'c', account_id: 'a' }).ok, false);
  assert.equal(validateIdentityBinding(binding, { principal_id: 'p', context_id: 'c', account_id: '' }).ok, false);
});

test('assertRequest throws sanitized errors at the transport boundary', () => {
  assert.doesNotThrow(() => assertRequest(requests().hello));
  assert.throws(() => assertRequest({ ...requests().hello, payload: { ...requests().hello.payload, raw_error: 'private' } }), /Invalid protocol request/);
});
