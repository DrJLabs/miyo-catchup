import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readdirSync,
  readSync,
  writeSync,
  constants as fsConstants,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  MAX_RAW_CHUNK_BYTES,
  MAX_RESPONSE_BYTES,
  validateRequest,
} from './contracts.mjs';
import { openDurableDatabase, transaction } from './sqlite.mjs';
import {
  assertContainedPath,
  ensurePrivateDirectory,
  normalizeAbsolutePath,
} from './safe-paths.mjs';

/**
 * The receiver is deliberately a T02 qualification harness, not a collector.
 * It accepts one session result and one pinned body result. The caller must
 * hold a process-lifetime OS ownership lock before constructing it. A
 * process-local guard prevents accidental duplicate writers in one process;
 * it is not a substitute for flock across processes.
 */

const PERMIT_MS = 5_000;
const SPACING_MS = 5_000;
const MAX_SESSION_BYTES = 16 * 1024;
const MAX_REQUESTS = 1_000;
const MAX_CHUNKS = Math.floor(MAX_RESPONSE_BYTES / MAX_RAW_CHUNK_BYTES) + 1;
const MAX_DATE_MS = 8_640_000_000_000_000;
const RECEIVER_OPERATIONS = new Set([
  'hello', 'claim_work', 'request_permit', 'dispatch_started', 'result_chunk',
  'commit_result', 'request_failed', 'reconcile_dispatch',
]);
const ROOTS = new Set();

function fail(code, retryAt) {
  const error = { code };
  if (retryAt !== undefined) error.retry_at = retryAt;
  return error;
}

function reply(requestId, ok, value) {
  return ok
    ? { protocol_version: 1, request_id: requestId, ok: true, result: value }
    : { protocol_version: 1, request_id: requestId, ok: false, error: value };
}

function iso(ms) { return new Date(ms).toISOString(); }

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readClock(clock) {
  let value;
  if (typeof clock === 'function') value = clock();
  else if (clock && typeof clock.read === 'function') value = clock.read();
  else if (clock && typeof clock.now === 'function') value = { wall: clock.now() };
  else value = { wall: Date.now(), monotonic: performance.now(), bootId: 'runtime' };
  if (typeof value === 'number') value = { wall: value };
  const wall = Number(value?.wall ?? value?.wall_ms ?? value?.now);
  if (!Number.isFinite(wall)) throw new TypeError('clock must provide a finite wall time');
  return {
    wall,
    monotonic: Number.isFinite(Number(value?.monotonic)) ? Number(value.monotonic) : null,
    bootId: typeof value?.bootId === 'string' ? value.bootId : null,
  };
}

function cooldownEvidence(payload, observedAt, previous = null) {
  const floor = Math.max(previous ?? 0, observedAt + 3_600_000);
  let deadline = floor;
  let classification = payload.retry_after === undefined ? 'absent' : 'invalid';
  let unbounded = false;
  const raw = payload.retry_after;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const candidate = BigInt(observedAt) + BigInt(raw) * 1000n;
    if (candidate > BigInt(MAX_DATE_MS)) { classification = 'overflow'; unbounded = true; }
    else { classification = 'seconds'; deadline = Math.max(floor, Number(candidate)); }
  } else if (typeof raw === 'string'
    && /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)
    && Number.isFinite(Date.parse(raw))) {
    classification = 'http_date'; deadline = Math.max(floor, Date.parse(raw));
  }
  return { deadline, classification, unbounded };
}

function validIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError(`${label} must be a bounded identifier`);
  }
  return value;
}

function privatePath(root, pathname, label, { allowMissingLeaf = true, trustedBoundary = undefined } = {}) {
  return assertContainedPath(pathname, root, {
    label,
    trustedBoundary,
    expectedType: 'file',
    allowMissingLeaf,
    privateMode: true,
  });
}

function createPrivateFile(pathname) {
  let descriptor;
  try {
    descriptor = openSync(pathname, fsConstants.O_RDWR | fsConstants.O_CREAT |
      fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  return true;
}

function writeState(db, state) {
  db.prepare('UPDATE probe_state SET state = ? WHERE id = 1').run(JSON.stringify(state));
}

function responseForDuplicate(db, request) {
  const row = db.prepare('SELECT request_hash, reply FROM request_receipts WHERE request_id = ?')
    .get(request.request_id);
  if (!row) return null;
  const requestHash = digest(canonical(request));
  if (row.request_hash !== requestHash) {
    return reply(request.request_id, false, fail('invalid_request'));
  }
  return JSON.parse(row.reply);
}

function bodyIsUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function readExact(pathname, offset, length) {
  const descriptor = openSync(pathname, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const bytes = Buffer.alloc(length);
    let received = 0;
    while (received < length) {
      const count = readSync(descriptor, bytes, received, length - received, offset + received);
      if (!count) return null;
      received += count;
    }
    return bytes;
  } finally { closeSync(descriptor); }
}

function ensureTransferFile(pathname) {
  if (!existsSync(pathname)) createPrivateFile(pathname);
}

function appendBytes(pathname, bytes) {
  const descriptor = openSync(pathname, fsConstants.O_WRONLY | fsConstants.O_APPEND |
    (fsConstants.O_NOFOLLOW ?? 0));
  try {
    let written = 0;
    while (written < bytes.length) written += writeSync(descriptor, bytes, written, bytes.length - written);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

function writeAllAndSync(pathname, bytes) {
  const descriptor = openSync(pathname, fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    let written = 0;
    while (written < bytes.length) written += writeSync(descriptor, bytes, written, bytes.length - written, written);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

function fsyncDirectory(pathname) {
  const descriptor = openSync(pathname, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function readBoundedFile(pathname) {
  const descriptor = openSync(pathname, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_RESPONSE_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) return null;
      offset += count;
    }
    return bytes;
  } finally { closeSync(descriptor); }
}

function assertBinding(options) {
  const binding = options.binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new TypeError('binding is required');
  for (const key of ['binding_id', 'principal_id', 'context_id', 'account_id']) validIdentifier(binding[key], `binding.${key}`);
  return Object.freeze({ ...binding });
}

function stateSummary(state, conversationId) {
  return {
    stage: state.stage,
    probe_complete: state.stage === 'probe_complete',
    catalog_complete: false,
    verified: false,
    conversation_id: conversationId,
    attested: state.attested,
    session_committed: state.session?.status === 'committed',
    body_committed: state.body?.status === 'committed',
    dispatch_state: state.blocker ?? null,
    blocker: state.blocker ?? null,
    raw_bytes: state.body?.raw_bytes ?? null,
    sha256: state.body?.sha256 ?? null,
    artifact_id: state.body?.artifact_id ?? null,
    request_count: state.request_count,
    retry_at: state.cooldown_until === null || state.cooldown_unbounded ? null : iso(state.cooldown_until),
    cooldown_unbounded: state.cooldown_unbounded,
  };
}

function checkFence(state, request, permitRequired = true) {
  if (request.run_id !== state.run_id || request.attempt_id !== state.attempt_id ||
      request.lease_generation !== state.lease_generation) return false;
  if (permitRequired && request.permit_id !== state.permit?.permit_id) return false;
  return true;
}

/**
 * Construct one bounded, private T02 receiver.
 *
 * `root` is mandatory; `trustedBoundary` is an explicit test-only exception to
 * full ancestor validation. `validateBody` is mandatory for conversation scope;
 * session-only scope never admits body work and therefore does not require one.
 * `ownership` is a required caller-held
 * lock assertion, not an acquisition mechanism; in production the
 * caller must hold an OS flock for the process lifetime. This module never
 * creates PID/stale lock files or claims cross-process exclusivity.
 */
export function createProbeReceiver(options = {}) {
  const requestedScope = options.scope;
  const scope = requestedScope === undefined ? 'conversation' : requestedScope;
  if (scope !== 'conversation' && scope !== 'session-only') {
    throw new TypeError('scope must be conversation or session-only');
  }
  const root = normalizeAbsolutePath(options.root, 'probe root');
  const trustedBoundary = options.trustedBoundary === undefined
    ? undefined : normalizeAbsolutePath(options.trustedBoundary, 'trustedBoundary');
  const binding = assertBinding(options);
  const conversationId = validIdentifier(options.conversationId, 'conversationId');
  if (scope === 'conversation' && typeof options.validateBody !== 'function') {
    throw new TypeError('validateBody must be injected');
  }
  // Session-only roots never admit body work. Keep a defensive false validator
  // in case a malformed or manually altered permit reaches the commit branch;
  // a caller-supplied callback must not affect this scope.
  const validateBody = scope === 'session-only' ? () => false : options.validateBody;
  if (typeof options.ownership !== 'function' || options.ownership() !== true) {
    throw new Error('probe receiver ownership was not proven');
  }
  if (ROOTS.has(root)) throw new Error('probe receiver already open for root');

  ensurePrivateDirectory(root, { trustedBoundary });
  const transfers = join(root, 'transfers');
  ensurePrivateDirectory(transfers, { trustedBoundary });
  const artifacts = join(root, 'artifacts');
  ensurePrivateDirectory(artifacts, { trustedBoundary });
  const dbPath = join(root, 'probe-state.db');
  privatePath(root, dbPath, 'probe database', { trustedBoundary });
  const db = openDurableDatabase({ path: dbPath, root, trustedBoundary });
  const existingStateTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'probe_state'").get();
  const existing = existingStateTable ? db.prepare('SELECT state FROM probe_state WHERE id = 1').get() : null;
  db.exec(`CREATE TABLE IF NOT EXISTS probe_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS request_receipts (
    request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, reply TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chunks (
    permit_id TEXT NOT NULL, sequence INTEGER NOT NULL, offset INTEGER NOT NULL,
    decoded_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
    PRIMARY KEY (permit_id, sequence)
  );`);

  let state;
  const clock = options.clock;
  const now = () => readClock(clock);
  const bindingHash = scope === 'session-only'
    ? digest(canonical({ binding, scope }))
    : digest(canonical(binding));
  const initial = {
    scope, stage: 'new', request_count: 0, attested: false, blocker: null,
    worker_instance_id: randomUUID(), run_id: null, attempt_id: null,
    lease_generation: 0, browser_instance_id: null, document_id: null,
    last_clock: now(), next_permit_at: null, next_permit_monotonic: null,
    lease_valid_until: null, lease_monotonic_until: null,
    cooldown_until: null, cooldown_unbounded: false, failure: null,
    binding_hash: bindingHash, conversation_hash: digest(conversationId),
    session: null, body: null, permit: null,
  };
  if (existing) {
    state = JSON.parse(existing.state);
    const storedScope = state.scope === undefined ? 'conversation' : state.scope;
    if (storedScope !== scope || state.binding_hash !== initial.binding_hash || state.conversation_hash !== initial.conversation_hash) {
      db.close();
      throw new Error('probe scope, binding or conversation changed for existing root');
    }
    // Preserve compatibility with roots created before scope was introduced,
    // while durably pinning their implicit default conversation scope.
    if (state.scope === undefined) {
      state.scope = 'conversation';
      transaction(db, (connection) => writeState(connection, state));
    }
  }
  else transaction(db, (connection) => {
    connection.prepare('INSERT INTO probe_state (id, state) VALUES (1, ?)').run(JSON.stringify(initial));
    state = initial;
  });

  // A crash can leave a transfer or artifact with no durable terminal state.
  // Preserve evidence and fence the root; never reset it into a refetchable run.
  const transferRows = db.prepare('SELECT DISTINCT permit_id FROM chunks').all();
  const hasOrphan = transferRows.some((row) => {
    const transfer = join(transfers, `${row.permit_id}.part`);
    return existsSync(transfer) && state.permit?.permit_id === row.permit_id && state.permit?.status !== 'committed' && state.permit?.status !== 'failed';
  });
  if (state.stage !== 'new' && state.stage !== 'probe_complete') {
    state.blocker ??= 'dispatch_uncertain';
    state.stage = 'blocked';
  } else if (hasOrphan) {
    state.blocker = 'dispatch_uncertain';
    state.stage = 'blocked';
  }
  const artifactNames = readdirSync(artifacts);
  const hasOrphanArtifact = artifactNames.some((name) => name.endsWith('.json')) &&
    !(state.body?.artifact_path && artifactNames.includes(state.body.artifact_path.split('/').pop()));
  if (hasOrphanArtifact && state.stage === 'probe_complete') {
    state.blocker = 'recovery_evidence_missing';
    state.stage = 'blocked';
  } else if (hasOrphanArtifact && state.stage === 'new') {
    state.blocker = 'dispatch_uncertain';
    state.stage = 'blocked';
  }
  if (state.stage === 'probe_complete') {
    let artifact = null;
    try {
      if (state.body?.artifact_path) {
        privatePath(root, state.body.artifact_path, 'probe artifact', { allowMissingLeaf: false, trustedBoundary });
        artifact = readBoundedFile(state.body.artifact_path);
      }
    } catch { artifact = null; }
    if (!artifact || artifact.length !== state.body.raw_bytes || digest(artifact) !== state.body.sha256) {
      state.blocker = 'recovery_evidence_missing';
      state.stage = 'blocked';
    }
  }
  if (state.blocker) transaction(db, (connection) => writeState(connection, state));
  ROOTS.add(root);
  let closed = false;
  let faulted = false;
  const sessionBuffers = new Map();
  const sessionChunks = new Map();

  function persistState() { writeState(db, state); }

  function checkRequest(envelope) {
    const validation = validateRequest(envelope);
    if (!validation.ok) throw new TypeError(`invalid probe request: ${validation.errors.join('; ')}`);
    return envelope;
  }

  function boundedResponse(request, response) { return response; }

  function process(envelope) {
    if (closed || faulted) throw new Error('probe receiver is closed or requires restart');
    if (options.ownership() !== true) throw new Error('probe receiver ownership was lost');
    checkRequest(envelope);
    const duplicate = responseForDuplicate(db, envelope);
    if (duplicate) {
      if (duplicate.ok && envelope.operation === 'commit_result') {
        const evidence = [state.session, state.body].find((item) => item?.artifact_id === duplicate.result.artifact_id);
        let bytes = null;
        try {
          if (evidence) {
            privatePath(root, evidence.artifact_path, 'probe artifact', { allowMissingLeaf: false, trustedBoundary });
            bytes = readBoundedFile(evidence.artifact_path);
          }
        } catch { /* missing, unsafe or altered evidence must not replay success */ }
        if (state.blocker === 'recovery_evidence_missing' || !bytes
          || bytes.length !== duplicate.result.raw_bytes || digest(bytes) !== duplicate.result.sha256) {
          state.blocker = 'recovery_evidence_missing'; state.stage = 'blocked';
          transaction(db, persistState);
          return reply(envelope.request_id, false, fail('recovery_evidence_missing'));
        }
      }
      return duplicate;
    }
    if (state.request_count >= MAX_REQUESTS) {
      state.blocker = 'budget_exhausted'; state.stage = 'blocked';
      persistState();
      return reply(envelope.request_id, false, fail('budget_exhausted'));
    }
    const before = structuredClone(state);
    try {
      return transaction(db, (connection) => {
        const response = handle(envelope);
        state.request_count += 1;
        writeState(connection, state);
        connection.prepare('INSERT INTO request_receipts (request_id, request_hash, reply) VALUES (?, ?, ?)')
          .run(envelope.request_id, digest(canonical(envelope)), JSON.stringify(response));
        return response;
      });
    } catch (error) {
      state = before;
      // Files may already be durable while the DB transaction rolled back.
      // Do not allow this instance to keep allocating artifacts or replaying
      // transitions after an I/O fault; reopening fences incomplete state.
      faulted = true;
      throw error;
    }
  }

  function handle(envelope) {
    if (!state.blocker && ['claim_work', 'request_permit', 'dispatch_started'].includes(envelope.operation)) {
      const current = now();
      const prior = state.last_clock;
      if (!Number.isSafeInteger(current.wall) || current.wall < 0 || current.wall > MAX_DATE_MS - 3_600_000
        || !Number.isFinite(current.monotonic) || current.monotonic < 0 || !current.bootId
        || !Number.isFinite(prior?.monotonic) || current.bootId !== prior.bootId
        || current.monotonic < prior.monotonic || current.wall < prior.wall
        || Math.abs((current.wall - prior.wall) - (current.monotonic - prior.monotonic)) > 60_000) {
        state.blocker = 'clock_untrusted'; state.stage = 'blocked';
        return reply(envelope.request_id, false, fail('clock_untrusted'));
      }
      state.last_clock = current;
    }
    if (!RECEIVER_OPERATIONS.has(envelope.operation)) {
      return boundedResponse(envelope, reply(envelope.request_id, false, fail('blocked')));
    }
    if (envelope.operation === 'hello') return hello(envelope);
    if (envelope.operation === 'claim_work') return claim(envelope);
    if (envelope.operation === 'request_permit') return permit(envelope);
    if (envelope.operation === 'dispatch_started') return dispatchStarted(envelope);
    if (envelope.operation === 'result_chunk') return chunk(envelope);
    if (envelope.operation === 'commit_result') return commit(envelope);
    if (envelope.operation === 'request_failed') return failed(envelope);
    return reconcile(envelope);
  }

  function hello(request) {
    const response = reply(request.request_id, true, {
      worker_instance_id: state.worker_instance_id, protocol_version: 1, config_version: 1,
    });
    return boundedResponse(request, response);
  }

  function lease(nowValue, workUnit) {
    return {
      run_id: state.run_id, attempt_id: state.attempt_id,
      lease_generation: state.lease_generation, lease_expires_at: iso(nowValue.wall + PERMIT_MS),
      work_unit: workUnit,
    };
  }

  function claim(request) {
    const p = request.payload;
    if (scope === 'session-only' && state.attested) {
      return boundedResponse(request, reply(request.request_id, false, fail(state.blocker ?? 'blocked')));
    }
    if (scope === 'session-only' && (p.principal_id !== null || p.context_id !== null)) {
      return boundedResponse(request, reply(request.request_id, false, fail('blocked')));
    }
    if (state.blocker || state.stage === 'probe_complete') {
      return boundedResponse(request, reply(request.request_id, false, fail(state.blocker ?? 'blocked')));
    }
    if (state.browser_instance_id === null) state.browser_instance_id = p.browser_instance_id;
    if (state.browser_instance_id !== p.browser_instance_id) {
      return boundedResponse(request, reply(request.request_id, false, fail('identity_mismatch')));
    }
    if (!state.run_id) {
      if (p.principal_id !== null || p.context_id !== null) {
        return boundedResponse(request, reply(request.request_id, false, fail('identity_mismatch')));
      }
      state.run_id = randomUUID(); state.attempt_id = randomUUID(); state.lease_generation = 1;
      state.stage = 'session_claimed';
      persistState();
    } else if (!state.attested && (p.principal_id !== null || p.context_id !== null)) {
      return boundedResponse(request, reply(request.request_id, false, fail('identity_mismatch')));
    } else if (state.attested && (p.principal_id !== binding.principal_id || p.context_id !== binding.context_id)) {
      return boundedResponse(request, reply(request.request_id, false, fail('identity_mismatch')));
    }
    const workUnit = state.attested ? 'body' : 'session-check';
    const current = now();
    if (state.lease_valid_until !== null && (current.wall > state.lease_valid_until
      || current.monotonic > state.lease_monotonic_until) && state.stage !== 'session_committed') {
      return boundedResponse(request, reply(request.request_id, false, fail('blocked')));
    }
    state.lease_valid_until = current.wall + PERMIT_MS;
    state.lease_monotonic_until = current.monotonic + PERMIT_MS;
    persistState();
    const response = reply(request.request_id, true, { lease: lease(current, workUnit) });
    return boundedResponse(request, response);
  }

  function fence(request, workUnit) {
    if (!checkFence(state, request, false) || state.blocker || state.stage === 'probe_complete') return false;
    if (state.attested && workUnit === 'session-check') return false;
    if (!state.attested && workUnit === 'body') return false;
    return true;
  }

  function permit(request) {
    if (scope === 'session-only' && state.attested) {
      return boundedResponse(request, reply(request.request_id, false, fail(state.blocker ?? 'blocked')));
    }
    const expectedUnit = state.attested ? 'body' : 'session-check';
    if (!fence(request, request.payload.work_unit_id) || request.payload.work_unit_id !== expectedUnit) {
      return boundedResponse(request, reply(request.request_id, false, fail(state.blocker ?? 'blocked')));
    }
    const current = now();
    if (state.lease_valid_until !== null && (current.wall > state.lease_valid_until
      || current.monotonic > state.lease_monotonic_until)) {
      return boundedResponse(request, reply(request.request_id, false, fail('blocked')));
    }
    if (state.permit && !['committed', 'failed'].includes(state.permit.status)) {
      return boundedResponse(request, reply(request.request_id, false, fail(state.blocker ?? 'busy')));
    }
    if (state.next_permit_at !== null && (current.wall < state.next_permit_at
      || current.monotonic < state.next_permit_monotonic)) {
      return boundedResponse(request, reply(request.request_id, false, fail('busy', iso(state.next_permit_at))));
    }
    const permitId = randomUUID();
    const validUntil = current.wall + PERMIT_MS;
    state.permit = {
      permit_id: permitId, kind: expectedUnit, status: 'granted', granted_at: current.wall,
      valid_until: validUntil, monotonic_until: current.monotonic + PERMIT_MS,
      document_id: null, raw_bytes: 0, next_sequence: 0,
    };
    state.next_permit_at = validUntil + SPACING_MS;
    state.next_permit_monotonic = current.monotonic + PERMIT_MS + SPACING_MS;
    state.stage = expectedUnit === 'session-check' ? 'session_permit' : 'body_permit';
    persistState();
    const args = expectedUnit === 'session-check' ? {} : { conversation_ids: [conversationId] };
    return boundedResponse(request, reply(request.request_id, true, {
      granted: true, permit_id: permitId,
      request_kind: expectedUnit === 'session-check' ? 'session_check' : 'body',
      arguments: args, valid_until: iso(validUntil),
    }));
  }

  function permitFor(request) {
    return !state.blocker && state.permit && request.permit_id === state.permit.permit_id &&
      checkFence(state, request, true) ? state.permit : null;
  }

  function dispatchStarted(request) {
    if (scope === 'session-only' && state.attested) {
      return boundedResponse(request, reply(request.request_id, false, fail(state.blocker ?? 'blocked')));
    }
    const permitState = permitFor(request);
    if (!permitState || permitState.status !== 'granted') {
      return boundedResponse(request, reply(request.request_id, false, fail(state.blocker ?? 'blocked')));
    }
    const current = now();
    if (current.wall > permitState.valid_until || current.monotonic > permitState.monotonic_until) {
      state.blocker = 'dispatch_uncertain'; state.stage = 'blocked';
      persistState();
      return boundedResponse(request, reply(request.request_id, false, fail('blocked')));
    }
    if (state.browser_instance_id !== request.payload.browser_instance_id ||
        (state.document_id !== null && state.document_id !== request.payload.document_id)) {
      return boundedResponse(request, reply(request.request_id, false, fail('identity_mismatch')));
    }
    permitState.status = 'started';
    permitState.document_id = request.payload.document_id;
    state.document_id = request.payload.document_id;
    state.stage = permitState.kind === 'session-check' ? 'session_started' : 'body_started';
    persistState();
    return boundedResponse(request, reply(request.request_id, true, { accepted: true }));
  }

  function chunk(request) {
    const permitState = permitFor(request);
    if (!permitState || permitState.status !== 'started' || !permitState.document_id) {
      return boundedResponse(request, reply(request.request_id, false, fail(state.blocker ?? 'blocked')));
    }
    const bytes = Buffer.from(request.payload.data, 'base64');
    const sequence = request.payload.sequence;
    const partPath = privatePath(root, join(transfers, `${permitState.permit_id}.part`), 'probe transfer', { trustedBoundary });
    if (sequence < permitState.next_sequence) {
      const prior = permitState.kind === 'session-check'
        ? sessionChunks.get(permitState.permit_id)?.get(sequence)
        : db.prepare('SELECT offset, decoded_bytes, sha256 FROM chunks WHERE permit_id = ? AND sequence = ?')
          .get(permitState.permit_id, sequence);
      const matching = permitState.kind === 'session-check'
        ? prior?.equals(bytes)
        : prior && prior.decoded_bytes === bytes.length && prior.sha256 === digest(bytes) &&
          readExact(partPath, Number(prior.offset), bytes.length)?.equals(bytes);
      if (!matching) {
        state.blocker = 'local_conflict'; state.stage = 'blocked';
        persistState();
        return boundedResponse(request, reply(request.request_id, false, fail('local_conflict')));
      }
      return boundedResponse(request, reply(request.request_id, true, { next_sequence: permitState.next_sequence }));
    }
    const responseCap = permitState.kind === 'session-check' ? MAX_SESSION_BYTES : MAX_RESPONSE_BYTES;
    if (sequence !== permitState.next_sequence || sequence >= MAX_CHUNKS || permitState.raw_bytes + bytes.length > responseCap) {
      return boundedResponse(request, reply(request.request_id, false, fail('invalid_request')));
    }
    if (permitState.kind === 'session-check') {
      const priorChunks = sessionChunks.get(permitState.permit_id) ?? new Map();
      priorChunks.set(sequence, Buffer.from(bytes));
      sessionChunks.set(permitState.permit_id, priorChunks);
      const priorBuffer = sessionBuffers.get(permitState.permit_id) ?? Buffer.alloc(0);
      sessionBuffers.set(permitState.permit_id, Buffer.concat([priorBuffer, bytes], priorBuffer.length + bytes.length));
      permitState.raw_bytes += bytes.length;
      permitState.next_sequence += 1;
      state.stage = 'session_partial';
      persistState();
      return boundedResponse(request, reply(request.request_id, true, { next_sequence: permitState.next_sequence }));
    }
    ensureTransferFile(partPath);
    const offset = permitState.raw_bytes;
    appendBytes(partPath, bytes);
    permitState.raw_bytes += bytes.length;
    permitState.next_sequence += 1;
    state.stage = permitState.kind === 'session-check' ? 'session_partial' : 'body_partial';
    db.prepare('INSERT INTO chunks (permit_id, sequence, offset, decoded_bytes, sha256) VALUES (?, ?, ?, ?, ?)')
      .run(permitState.permit_id, sequence, offset, bytes.length, digest(bytes));
    persistState();
    return boundedResponse(request, reply(request.request_id, true, { next_sequence: permitState.next_sequence }));
  }

  function commit(request) {
    const permitState = permitFor(request);
    if (!permitState || permitState.status !== 'started' || permitState.next_sequence !== request.payload.chunk_count ||
        permitState.raw_bytes !== request.payload.raw_bytes) {
      return boundedResponse(request, reply(request.request_id, false, fail(state.blocker ?? 'invalid_body')));
    }
    const partPath = privatePath(root, join(transfers, `${permitState.permit_id}.part`), 'probe transfer', { trustedBoundary });
    const bytes = permitState.kind === 'session-check'
      ? sessionBuffers.get(permitState.permit_id)
      : (existsSync(partPath) ? readBoundedFile(partPath) : null);
    if (!bytes) {
      state.blocker = 'recovery_evidence_missing'; state.stage = 'blocked';
      persistState();
      return boundedResponse(request, reply(request.request_id, false, fail('recovery_evidence_missing')));
    }
    if (bytes.length !== request.payload.raw_bytes || digest(bytes) !== request.payload.sha256 || !bodyIsUtf8(bytes)) {
      state.blocker = 'invalid_body'; state.stage = 'blocked';
      persistState();
      return boundedResponse(request, reply(request.request_id, false, fail('invalid_body')));
    }
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
      state.blocker = 'invalid_body'; state.stage = 'blocked';
      persistState();
      return boundedResponse(request, reply(request.request_id, false, fail('invalid_body')));
    }
    if (permitState.kind === 'session-check') {
      const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).sort() : [];
      if (keys.length !== 2 || keys[0] !== 'context_id' || keys[1] !== 'principal_id' ||
          parsed.principal_id !== binding.principal_id || parsed.context_id !== binding.context_id) {
        state.blocker = 'identity_mismatch'; state.stage = 'blocked';
        persistState();
        return boundedResponse(request, reply(request.request_id, false, fail('identity_mismatch')));
      }
    } else {
      let valid = false;
      try { valid = validateBody(parsed, conversationId) === true; } catch { valid = false; }
      if (!valid) {
        state.blocker = 'invalid_body'; state.stage = 'blocked';
        persistState();
        return boundedResponse(request, reply(request.request_id, false, fail('invalid_body')));
      }
    }
    const artifactId = randomUUID();
    const artifactPath = privatePath(root, join(artifacts, `${artifactId}.json`), 'probe artifact', { trustedBoundary });
    if (!createPrivateFile(artifactPath)) {
      state.blocker = 'local_conflict'; state.stage = 'blocked';
      persistState();
      return boundedResponse(request, reply(request.request_id, false, fail('local_conflict')));
    }
    writeAllAndSync(artifactPath, bytes);
    fsyncDirectory(artifacts);
    const evidence = { artifact_id: artifactId, artifact_path: artifactPath, raw_bytes: bytes.length, sha256: request.payload.sha256, status: 'committed' };
    permitState.status = 'committed';
    permitState.artifact_id = artifactId;
    if (permitState.kind === 'session-check') {
      state.session = evidence; state.attested = true; state.stage = 'session_committed';
    } else {
      state.body = evidence; state.stage = 'probe_complete';
    }
    state.permit = null;
    persistState();
    return boundedResponse(request, reply(request.request_id, true, {
      artifact_id: artifactId, raw_bytes: bytes.length, sha256: request.payload.sha256,
    }));
  }

  function failed(request) {
    const permitState = permitFor(request);
    if (!permitState || !['granted', 'started'].includes(permitState.status)) {
      return boundedResponse(request, reply(request.request_id, false, fail(state.blocker ?? 'blocked')));
    }
    permitState.status = 'failed';
    const failureBlocker = {
      rate_limited: 'cooldown', auth_required: 'login_required',
      challenge: 'challenge_required', schema_changed: 'schema_changed',
      identity_mismatch: 'identity_mismatch',
    }[request.payload.failure_class] ?? 'blocked';
    state.blocker = failureBlocker;
    const observed = now();
    state.failure = { ...request.payload };
    if (request.payload.failure_class === 'rate_limited') {
      const usableTime = Number.isSafeInteger(observed.wall) && observed.wall >= 0
        && observed.wall <= MAX_DATE_MS - 3_600_000;
      const at = usableTime ? Math.max(observed.wall, state.last_clock.wall) : state.last_clock.wall;
      const cooldown = cooldownEvidence(request.payload, at, state.cooldown_until);
      state.cooldown_until = cooldown.deadline;
      state.cooldown_unbounded ||= cooldown.unbounded || !usableTime;
      state.failure.retry_after_class = cooldown.classification;
    }
    state.stage = 'blocked';
    persistState();
    return boundedResponse(request, reply(request.request_id, true, { recorded: true }));
  }

  function reconcile(request) {
    const permitState = permitFor(request);
    if (!permitState || !['granted', 'started'].includes(permitState.status)) {
      return boundedResponse(request, reply(request.request_id, false, fail(state.blocker ?? 'dispatch_uncertain')));
    }
    permitState.status = 'uncertain';
    state.blocker = 'dispatch_uncertain'; state.stage = 'blocked';
    persistState();
    return boundedResponse(request, reply(request.request_id, true, { state: 'dispatch_uncertain' }));
  }

  function snapshot() {
    return Object.freeze(structuredClone(stateSummary(state, conversationId)));
  }

  function close() {
    if (closed) return;
    closed = true;
    try { db.close(); } finally { ROOTS.delete(root); }
  }

  return Object.freeze({ request: process, snapshot, close });
}

export const PROBE_RECEIVER_LIMITS = Object.freeze({
  permitMs: PERMIT_MS, spacingMs: SPACING_MS, maxRequests: MAX_REQUESTS,
  maxChunks: MAX_CHUNKS, maxRawChunkBytes: MAX_RAW_CHUNK_BYTES,
  maxSessionBytes: MAX_SESSION_BYTES, maxResponseBytes: MAX_RESPONSE_BYTES,
});
