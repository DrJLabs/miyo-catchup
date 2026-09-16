import { jsonByteLength } from './framing.mjs';

/** Versioned, dependency-free protocol/status/receipt contracts.
 *
 * The JSON files in schemas/ are documentation and interchange contracts.  These
 * focused validators are the runtime boundary: they deliberately reject unknown
 * fields and values before callers perform any work.
 */

export const PROTOCOL_VERSION = 1;
export const STATUS_VERSION = 1;
export const RECEIPT_VERSION = 1;

export const REQUEST_OPERATIONS = Object.freeze([
  'hello', 'request_run', 'get_status', 'claim_work', 'request_permit',
  'dispatch_started', 'result_chunk', 'commit_result', 'request_failed',
  'reconcile_dispatch', 'pause', 'resume', 'verify'
]);
export const REPLY_ERROR_CODES = Object.freeze([
  'invalid_request', 'unsupported_version', 'unauthorized', 'busy', 'not_found',
  'mode_conflict', 'blocked', 'budget_exhausted', 'cooldown', 'dispatch_uncertain',
  'identity_mismatch', 'schema_changed', 'internal',
  'account_mismatch', 'login_required', 'challenge_required', 'clock_untrusted',
  'local_conflict', 'recovery_evidence_missing', 'index_stalled', 'disk_budget_exhausted',
  'waiting_for_browser', 'indexing_pending', 'native_sync_connected', 'catalog_cycle',
  'catalog_unstable', 'invalid_body', 'unsafe_path'
]);

export const MAX_MESSAGE_BYTES = 262_144;
export const MAX_CONTROL_PAYLOAD_BYTES = 16_384;
export const MAX_RAW_CHUNK_BYTES = 180 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const MAX_CURSOR_BYTES = 8 * 1024;
export const MAX_UNACKNOWLEDGED_CHUNKS = 2;
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// SemVer 2.0.0 with strict numeric identifiers and dot-separated build data.
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![\s\S])/;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const FORBIDDEN_KEYS = new Set([
  'token', 'access_token', 'refresh_token', 'cookie', 'cookies', 'authorization',
  'auth', 'credentials', 'password', 'secret', 'raw_response', 'raw_error',
  'error_message', 'exception', 'stack', 'headers', 'endpoint', 'url'
]);

function pathJoin(path, key) {
  return `${path}.${key}`;
}

function fail(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function object(errors, value, path, allowed, required = []) {
  if (!plainObject(value)) { fail(errors, path, 'must be an object'); return false; }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(errors, path, 'contains an unknown property');
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(errors, pathJoin(path, key), 'is required');
  }
  return true;
}

function string(errors, value, path, predicate, description) {
  if (typeof value !== 'string' || !predicate.test(value)) fail(errors, path, description);
}

function uuid(errors, value, path) { string(errors, value, path, UUID, 'must be a canonical lowercase UUID'); }
function id(errors, value, path) { string(errors, value, path, ID, 'must be a bounded identifier'); }
function version(errors, value, path) { string(errors, value, path, VERSION, 'must be a semantic version'); }
function sha(errors, value, path) { string(errors, value, path, SHA256, 'must be a lowercase SHA-256 digest'); }
function dateTime(errors, value, path) {
  if (typeof value !== 'string' || !DATE_TIME.test(value) || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) fail(errors, path, 'must be an ISO UTC timestamp');
}
function finiteInteger(errors, value, path, min = 0, max = MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || !Number.isSafeInteger(value) || value < min || value > max) fail(errors, path, 'must be a finite safe integer in range');
}
function enumValue(errors, value, path, choices) {
  if (!choices.includes(value)) fail(errors, path, `must be one of ${choices.join(', ')}`);
}
function emptyObject(errors, value, path) { object(errors, value, path, new Set()); }

function scanValues(errors, value) {
  try { jsonByteLength(value); } catch { fail(errors, '$', 'invalid or oversized JSON'); return false; }
  function visit(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    fail(errors, '$', 'nonfinite or unsafe integer');
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) value.forEach(visit);
  else for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) fail(errors, '$', 'contains a sensitive/raw field');
    visit(item);
  }
  }
  visit(value);
  return errors.length === 0;
}

function result(errors, value) {
  return Object.freeze({ ok: errors.length === 0, valid: errors.length === 0, errors: Object.freeze(errors), value: errors.length === 0 ? value : undefined });
}

function validateBase(errors, value, operation, requiredTop = ['protocol_version', 'request_id', 'operation', 'payload']) {
  const allowed = new Set(requiredTop);
  if (!object(errors, value, '$', allowed, requiredTop)) return false;
  if (value.protocol_version !== PROTOCOL_VERSION) fail(errors, '$.protocol_version', 'unsupported protocol version');
  uuid(errors, value.request_id, '$.request_id');
  enumValue(errors, value.operation, '$.operation', REQUEST_OPERATIONS);
  if (value.operation !== operation) fail(errors, '$.operation', `must be ${operation}`);
  return true;
}

function validatePayload(errors, value, operation) {
  const p = value.payload;
  const payloadPath = '$.payload';
  if (!plainObject(p)) { fail(errors, payloadPath, 'must be an object'); return; }
  switch (operation) {
    case 'hello': {
      if (!object(errors, p, payloadPath, new Set(['extension_version', 'browser_instance_id', 'capabilities']), ['extension_version', 'browser_instance_id', 'capabilities'])) return;
      version(errors, p.extension_version, `${payloadPath}.extension_version`); uuid(errors, p.browser_instance_id, `${payloadPath}.browser_instance_id`);
      if (!Array.isArray(p.capabilities) || p.capabilities.length > 16 || new Set(p.capabilities).size !== p.capabilities.length) fail(errors, `${payloadPath}.capabilities`, 'must be a unique bounded array');
      else p.capabilities.forEach((x, i) => enumValue(errors, x, `${payloadPath}.capabilities[${i}]`, ['session_check', 'catalog', 'body', 'chunking']));
      break;
    }
    case 'request_run':
      if (object(errors, p, payloadPath, new Set(['trigger_type', 'mode', 'idempotency_key']), ['trigger_type', 'mode', 'idempotency_key'])) {
        enumValue(errors, p.trigger_type, `${payloadPath}.trigger_type`, ['manual', 'daily', 'popup', 'cli']); enumValue(errors, p.mode, `${payloadPath}.mode`, ['publish', 'dry_run']);
        if (p.trigger_type === 'daily') {
          const k = p.idempotency_key;
          if (object(errors, k, `${payloadPath}.idempotency_key`, new Set(['binding_id', 'timezone', 'due_date']), ['binding_id', 'timezone', 'due_date'])) {
            id(errors, k.binding_id, `${payloadPath}.idempotency_key.binding_id`);
            string(errors, k.timezone, `${payloadPath}.idempotency_key.timezone`, /^[A-Za-z][A-Za-z0-9._+/-]{0,63}$/, 'must be a bounded timezone');
            string(errors, k.due_date, `${payloadPath}.idempotency_key.due_date`, /^\d{4}-\d{2}-\d{2}$/, 'must be a local due date');
          }
        } else uuid(errors, p.idempotency_key, `${payloadPath}.idempotency_key`);
      } break;
    case 'get_status':
      if (object(errors, p, payloadPath, new Set(['run_id']))) { if (p.run_id !== undefined) uuid(errors, p.run_id, `${payloadPath}.run_id`); } break;
    case 'claim_work':
      if (object(errors, p, payloadPath, new Set(['browser_instance_id', 'principal_id', 'context_id']), ['browser_instance_id', 'principal_id', 'context_id'])) {
        uuid(errors, p.browser_instance_id, `${payloadPath}.browser_instance_id`);
        if (p.principal_id !== null) id(errors, p.principal_id, `${payloadPath}.principal_id`);
        if (p.context_id !== null) id(errors, p.context_id, `${payloadPath}.context_id`);
        if ((p.principal_id === null) !== (p.context_id === null)) fail(errors, payloadPath, 'attestation must be complete or absent');
      } break;
    case 'request_permit':
      if (object(errors, p, payloadPath, new Set(['work_unit_id']), ['work_unit_id'])) id(errors, p.work_unit_id, `${payloadPath}.work_unit_id`); break;
    case 'dispatch_started':
      if (object(errors, p, payloadPath, new Set(['browser_instance_id', 'document_id']), ['browser_instance_id', 'document_id'])) { uuid(errors, p.browser_instance_id, `${payloadPath}.browser_instance_id`); id(errors, p.document_id, `${payloadPath}.document_id`); } break;
    case 'result_chunk': {
      if (!object(errors, p, payloadPath, new Set(['sequence', 'decoded_bytes', 'data']), ['sequence', 'decoded_bytes', 'data'])) break;
      finiteInteger(errors, p.sequence, `${payloadPath}.sequence`); finiteInteger(errors, p.decoded_bytes, `${payloadPath}.decoded_bytes`, 0, MAX_RAW_CHUNK_BYTES);
      if (typeof p.data !== 'string' || !BASE64.test(p.data) || p.data.length > 245760) fail(errors, `${payloadPath}.data`, 'must be bounded base64');
      else { let decoded; try { decoded = Buffer.from(p.data, 'base64'); } catch { decoded = null; } if (!decoded || decoded.length !== p.decoded_bytes || decoded.length > MAX_RAW_CHUNK_BYTES) fail(errors, `${payloadPath}.data`, 'decoded byte count exceeds declared bound'); }
      break;
    }
    case 'commit_result':
      if (object(errors, p, payloadPath, new Set(['chunk_count', 'raw_bytes', 'sha256']), ['chunk_count', 'raw_bytes', 'sha256'])) { finiteInteger(errors, p.chunk_count, `${payloadPath}.chunk_count`, 1); finiteInteger(errors, p.raw_bytes, `${payloadPath}.raw_bytes`, 0, MAX_RESPONSE_BYTES); sha(errors, p.sha256, `${payloadPath}.sha256`); } break;
    case 'request_failed':
      if (object(errors, p, payloadPath, new Set(['failure_class', 'http_status', 'retry_after']), ['failure_class'])) {
        enumValue(errors, p.failure_class, `${payloadPath}.failure_class`, ['network', 'timeout', 'rate_limited', 'auth_required', 'challenge', 'schema_changed', 'identity_mismatch', 'aborted']);
        if (p.http_status !== undefined) finiteInteger(errors, p.http_status, `${payloadPath}.http_status`, 100, 599);
        // The coordinator must classify missing/invalid/overflow headers and
        // persist the conservative floor. Transport validation must not lose 429s.
        if (p.retry_after !== undefined && (typeof p.retry_after !== 'string' || p.retry_after.length > 128)) fail(errors, `${payloadPath}.retry_after`, 'must be a bounded Retry-After header');
      } break;
    case 'reconcile_dispatch':
      if (object(errors, p, payloadPath, new Set(['browser_instance_id', 'document_id', 'outcome']), ['browser_instance_id', 'document_id', 'outcome'])) { uuid(errors, p.browser_instance_id, `${payloadPath}.browser_instance_id`); id(errors, p.document_id, `${payloadPath}.document_id`); enumValue(errors, p.outcome, `${payloadPath}.outcome`, ['settled', 'aborted', 'destroyed_context']); } break;
    case 'pause': case 'resume': case 'verify': emptyObject(errors, p, payloadPath); break;
    default: fail(errors, '$.operation', 'unknown operation');
  }
}

export function validateRequest(value) {
  const errors = [];
  if (!scanValues(errors, value)) return result(errors, value);
  if (plainObject(value) && REQUEST_OPERATIONS.includes(value.operation)) {
    const work = new Set(['request_permit']);
    const permit = new Set(['dispatch_started', 'result_chunk', 'commit_result', 'request_failed', 'reconcile_dispatch']);
    const required = work.has(value.operation) ? ['protocol_version', 'request_id', 'operation', 'payload', 'run_id', 'attempt_id', 'lease_generation'] : permit.has(value.operation) ? ['protocol_version', 'request_id', 'operation', 'payload', 'run_id', 'attempt_id', 'lease_generation', 'permit_id'] : value.operation === 'pause' || value.operation === 'resume' || value.operation === 'verify' ? ['protocol_version', 'request_id', 'operation', 'payload', 'run_id'] : ['protocol_version', 'request_id', 'operation', 'payload'];
    if (validateBase(errors, value, value.operation, required)) {
      if (work.has(value.operation) || permit.has(value.operation)) { uuid(errors, value.run_id, '$.run_id'); uuid(errors, value.attempt_id, '$.attempt_id'); finiteInteger(errors, value.lease_generation, '$.lease_generation'); }
      if (permit.has(value.operation)) uuid(errors, value.permit_id, '$.permit_id');
      if (['pause', 'resume', 'verify'].includes(value.operation)) uuid(errors, value.run_id, '$.run_id');
      validatePayload(errors, value, value.operation);
      if (value.operation !== 'result_chunk') {
        try { jsonByteLength(value.payload, MAX_CONTROL_PAYLOAD_BYTES); }
        catch { fail(errors, '$.payload', 'invalid or oversized control payload'); }
      }
    }
  } else if (plainObject(value)) {
    fail(errors, '$.operation', 'unknown operation');
  } else {
    fail(errors, '$', 'request must be an object');
  }
  return result(errors, value);
}

export const validateProtocolMessage = validateRequest;

function validateResult(errors, value, operation) {
  if (!plainObject(value)) { fail(errors, '$.result', 'must be an object'); return; }
  switch (operation) {
    case 'hello':
      if (object(errors, value, '$.result', new Set(['worker_instance_id', 'protocol_version', 'config_version']), ['worker_instance_id', 'protocol_version', 'config_version'])) { uuid(errors, value.worker_instance_id, '$.result.worker_instance_id'); if (value.protocol_version !== 1) fail(errors, '$.result.protocol_version', 'must be 1'); if (value.config_version !== 1) fail(errors, '$.result.config_version', 'must be 1'); } break;
    case 'request_run':
      if (object(errors, value, '$.result', new Set(['run_id', 'state', 'coalesced', 'blocked']), ['run_id', 'state', 'coalesced', 'blocked'])) { uuid(errors, value.run_id, '$.result.run_id'); enumValue(errors, value.state, '$.result.state', ['queued', 'running', 'paused', 'blocked', 'waiting_for_browser', 'complete', 'failed']); if (typeof value.coalesced !== 'boolean') fail(errors, '$.result.coalesced', 'must be boolean'); if (typeof value.blocked !== 'boolean') fail(errors, '$.result.blocked', 'must be boolean'); } break;
    case 'get_status':
      if (object(errors, value, '$.result', new Set(['status']), ['status'])) validateStatusValue(errors, value.status); break;
    case 'claim_work':
      if (object(errors, value, '$.result', new Set(['lease']), ['lease']) && value.lease !== null) {
        const l = value.lease;
        const keys = ['run_id', 'attempt_id', 'lease_generation', 'lease_expires_at', 'work_unit'];
        if (object(errors, l, '$.result.lease', new Set(keys), keys)) {
          uuid(errors, l.run_id, '$.result.lease.run_id'); uuid(errors, l.attempt_id, '$.result.lease.attempt_id');
          finiteInteger(errors, l.lease_generation, '$.result.lease.lease_generation');
          dateTime(errors, l.lease_expires_at, '$.result.lease.lease_expires_at'); id(errors, l.work_unit, '$.result.lease.work_unit');
        }
      } break;
    case 'request_permit':
      if (value.granted === true) {
        const keys = ['granted', 'permit_id', 'request_kind', 'arguments', 'valid_until'];
        if (object(errors, value, '$.result', new Set(keys), keys)) {
          uuid(errors, value.permit_id, '$.result.permit_id'); dateTime(errors, value.valid_until, '$.result.valid_until');
          enumValue(errors, value.request_kind, '$.result.request_kind', ['session_check', 'catalog', 'body']);
          const a = value.arguments;
          if (value.request_kind === 'session_check') emptyObject(errors, a, '$.result.arguments');
          if (value.request_kind === 'catalog' && object(errors, a, '$.result.arguments', new Set(['cursor']), ['cursor'])) {
            if (a.cursor !== null && (typeof a.cursor !== 'string' || Buffer.byteLength(a.cursor) > MAX_CURSOR_BYTES)) fail(errors, '$.result.arguments.cursor', 'invalid or oversized cursor');
          }
          if (value.request_kind === 'body' && object(errors, a, '$.result.arguments', new Set(['conversation_ids']), ['conversation_ids'])) {
            const ids = a.conversation_ids;
            if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5 || new Set(ids).size !== ids.length) fail(errors, '$.result.arguments.conversation_ids', 'must contain one to five unique IDs');
            else ids.forEach((item) => id(errors, item, '$.result.arguments.conversation_ids'));
          }
        }
      } else if (object(errors, value, '$.result', new Set(['granted', 'denial_code']), ['granted', 'denial_code'])) {
        if (value.granted !== false) fail(errors, '$.result.granted', 'must be boolean');
        enumValue(errors, value.denial_code, '$.result.denial_code', REPLY_ERROR_CODES);
      } break;
    case 'dispatch_started': if (object(errors, value, '$.result', new Set(['accepted']), ['accepted']) && typeof value.accepted !== 'boolean') fail(errors, '$.result.accepted', 'must be boolean'); break;
    case 'result_chunk': if (object(errors, value, '$.result', new Set(['next_sequence']), ['next_sequence'])) finiteInteger(errors, value.next_sequence, '$.result.next_sequence'); break;
    case 'commit_result': if (object(errors, value, '$.result', new Set(['artifact_id', 'raw_bytes', 'sha256']), ['artifact_id', 'raw_bytes', 'sha256'])) { uuid(errors, value.artifact_id, '$.result.artifact_id'); finiteInteger(errors, value.raw_bytes, '$.result.raw_bytes', 0, MAX_RESPONSE_BYTES); sha(errors, value.sha256, '$.result.sha256'); } break;
    case 'request_failed': if (object(errors, value, '$.result', new Set(['recorded']), ['recorded']) && typeof value.recorded !== 'boolean') fail(errors, '$.result.recorded', 'must be boolean'); break;
    case 'reconcile_dispatch': if (object(errors, value, '$.result', new Set(['state']), ['state'])) enumValue(errors, value.state, '$.result.state', ['settled', 'aborted', 'dispatch_uncertain']); break;
    case 'pause': case 'resume': if (object(errors, value, '$.result', new Set(['state']), ['state'])) enumValue(errors, value.state, '$.result.state', ['pause_requested', 'paused_at_safe_boundary', 'resumed']); break;
    case 'verify': if (object(errors, value, '$.result', new Set(['status']), ['status'])) enumValue(errors, value.status, '$.result.status', ['verified', 'incomplete', 'blocked']); break;
  }
}

export function validateReply(value, expectedOperation) {
  const errors = [];
  if (!scanValues(errors, value)) return result(errors, value);
  if (!object(errors, value, '$', new Set(['protocol_version', 'request_id', 'ok', 'result', 'error']), ['protocol_version', 'request_id', 'ok'])) return result(errors, value);
  if (value.protocol_version !== PROTOCOL_VERSION) fail(errors, '$.protocol_version', 'unsupported protocol version');
  uuid(errors, value.request_id, '$.request_id');
  if (typeof value.ok !== 'boolean') fail(errors, '$.ok', 'must be boolean');
  if (value.ok) {
    if (value.error !== undefined) fail(errors, '$.error', 'must not be present on success');
    if (!REQUEST_OPERATIONS.includes(expectedOperation)) fail(errors, '$.result', 'known request operation is required');
    else validateResult(errors, value.result, expectedOperation);
    try { jsonByteLength(value.result, MAX_CONTROL_PAYLOAD_BYTES); } catch { fail(errors, '$.result', 'invalid or oversized control result'); }
  }
  else { if (value.result !== undefined) fail(errors, '$.result', 'must not be present on failure'); if (!object(errors, value.error, '$.error', new Set(['code', 'retry_at']), ['code'])) return result(errors, value); enumValue(errors, value.error.code, '$.error.code', REPLY_ERROR_CODES); if (value.error.retry_at !== undefined) dateTime(errors, value.error.retry_at, '$.error.retry_at'); }
  return result(errors, value);
}

export function validateIdentityBinding(binding, observed) {
  const errors = [];
  if (!scanValues(errors, binding) || !scanValues(errors, observed)) return result(errors, observed);
  const keys = ['principal_id', 'context_id', 'account_id'];
  if (object(errors, binding, '$.binding', new Set(['binding_id', ...keys]), ['binding_id', ...keys])) {
    for (const key of ['binding_id', ...keys]) id(errors, binding[key], `$.binding.${key}`);
  }
  if (object(errors, observed, '$.observed', new Set(keys), keys)) {
    for (const key of keys) {
      id(errors, observed[key], `$.observed.${key}`);
      if (binding?.[key] !== observed[key]) fail(errors, `$.observed.${key}`, 'does not match configured binding');
    }
  }
  return result(errors, observed);
}

export function assertIdentityBinding(binding, observed) { return assertValid(validateIdentityBinding(binding, observed), 'identity'); }

export const STAGES = Object.freeze(['queued', 'catalog', 'downloading', 'staged', 'importing', 'indexing', 'final_verification', 'verified', 'dry_run_complete']);
export const COUNT_KEYS = Object.freeze(['catalog_pages', 'catalog_unique', 'selected', 'selected_new', 'selected_updated', 'selected_missing_body', 'downloaded', 'fetched', 'reused', 'staged', 'published', 'metadata_changed', 'byte_noop', 'indexed', 'verified', 'unchanged', 'blocked']);
export const BUDGET_KEYS = Object.freeze(['session_requests', 'catalog_pages', 'body_requests', 'total_requests', 'attempts']);

function nullable(errors, value, path, validate) { if (value !== null) validate(errors, value, path); }
function code(errors, value, path) { enumValue(errors, value, path, REPLY_ERROR_CODES); }
function boolean(errors, value, path) { if (typeof value !== 'boolean') fail(errors, path, 'must be boolean'); }
function validateScan(errors, scan, path, complete = false) {
  const keys = complete ? ['run_id', 'started_at', 'ended_at', 'coverage'] : ['generation', 'started_at', 'ended_at', 'coverage'];
  if (!object(errors, scan, path, new Set(keys), keys)) return;
  if (complete) uuid(errors, scan.run_id, `${path}.run_id`);
  else finiteInteger(errors, scan.generation, `${path}.generation`);
  for (const key of ['started_at', 'ended_at']) {
    if (complete) dateTime(errors, scan[key], `${path}.${key}`);
    else nullable(errors, scan[key], `${path}.${key}`, dateTime);
  }
  enumValue(errors, scan.coverage, `${path}.coverage`, complete ? ['qualified_catalog_only'] : [null, 'qualified_catalog_only']);
  if (scan.ended_at !== null && (scan.started_at === null || Date.parse(scan.ended_at) < Date.parse(scan.started_at))) fail(errors, path, 'invalid scan interval');
  if (scan.coverage !== null && scan.ended_at === null) fail(errors, path, 'coverage requires completed scan');
}

function validateStatusValue(errors, value) {
  const keys = ['status_version', 'generated_at', 'worker_instance_id', 'worker_version', 'connectivity', 'liveness', 'heartbeat_at', 'run', 'blockers', 'primary_blocker', 'pause_requested', 'paused_at_safe_boundary', 'last_complete_scan', 'last_fully_verified_run', 'receipt_evidence_at', 'next_scheduled_due_at', 'cooldown_until', 'retry_at', 'budget_remaining', 'error_code'];
  if (!object(errors, value, '$', new Set(keys), keys)) return;
  if (value.status_version !== STATUS_VERSION) fail(errors, '$.status_version', 'unsupported status version');
  dateTime(errors, value.generated_at, '$.generated_at');
  nullable(errors, value.worker_instance_id, '$.worker_instance_id', uuid);
  nullable(errors, value.worker_version, '$.worker_version', version);
  enumValue(errors, value.connectivity, '$.connectivity', ['available', 'unavailable']);
  enumValue(errors, value.liveness, '$.liveness', ['live', 'stale', 'unavailable']);
  if (value.connectivity === 'unavailable' && value.liveness !== 'unavailable') fail(errors, '$.liveness', 'disconnected worker cannot be live or stale-connected');
  if (value.connectivity === 'available' && value.liveness === 'unavailable') fail(errors, '$.liveness', 'available worker must be live or stale');
  for (const key of ['heartbeat_at', 'receipt_evidence_at', 'next_scheduled_due_at', 'cooldown_until', 'retry_at']) nullable(errors, value[key], `$.${key}`, dateTime);
  const generatedAt = Date.parse(value.generated_at);
  const heartbeatAt = value.heartbeat_at === null ? null : Date.parse(value.heartbeat_at);
  const heartbeatAge = heartbeatAt === null ? null : generatedAt - heartbeatAt;
  if (value.connectivity === 'available' && heartbeatAt !== null && heartbeatAt > generatedAt) fail(errors, '$.heartbeat_at', 'available status cannot report a future heartbeat');
  if (value.liveness === 'live' && (value.worker_instance_id === null || value.worker_version === null || heartbeatAt === null || heartbeatAge > 90_000 || heartbeatAge < 0)) fail(errors, '$.liveness', 'live status requires a current worker heartbeat');
  if (value.liveness === 'stale' && (value.worker_instance_id === null || value.worker_version === null || heartbeatAt === null || heartbeatAge <= 90_000)) fail(errors, '$.liveness', 'stale status requires an identified worker heartbeat older than the threshold');
  boolean(errors, value.pause_requested, '$.pause_requested'); boolean(errors, value.paused_at_safe_boundary, '$.paused_at_safe_boundary');
  if (value.paused_at_safe_boundary && !value.pause_requested) fail(errors, '$.paused_at_safe_boundary', 'requires pause intent');
  if (!Array.isArray(value.blockers) || value.blockers.length > REPLY_ERROR_CODES.length || new Set(value.blockers).size !== value.blockers.length) fail(errors, '$.blockers', 'must be unique bounded error codes');
  else value.blockers.forEach((item) => code(errors, item, '$.blockers'));
  nullable(errors, value.primary_blocker, '$.primary_blocker', code); nullable(errors, value.error_code, '$.error_code', code);
  if (Array.isArray(value.blockers) && (value.blockers.length === 0 ? value.primary_blocker !== null : !value.blockers.includes(value.primary_blocker))) fail(errors, '$.primary_blocker', 'must identify a present blocker');
  if (value.last_complete_scan !== null) validateScan(errors, value.last_complete_scan, '$.last_complete_scan', true);
  if (value.last_fully_verified_run !== null && object(errors, value.last_fully_verified_run, '$.last_fully_verified_run', new Set(['run_id', 'verified_at']), ['run_id', 'verified_at'])) {
    uuid(errors, value.last_fully_verified_run.run_id, '$.last_fully_verified_run.run_id'); dateTime(errors, value.last_fully_verified_run.verified_at, '$.last_fully_verified_run.verified_at');
  }
  if (object(errors, value.budget_remaining, '$.budget_remaining', new Set(BUDGET_KEYS), BUDGET_KEYS)) {
    const maxima = [5, 300, 200, 505, 3];
    BUDGET_KEYS.forEach((key, i) => finiteInteger(errors, value.budget_remaining[key], `$.budget_remaining.${key}`, 0, maxima[i]));
  }
  if (value.run === null) return;
  const run = value.run;
  const runKeys = ['run_id', 'attempt_id', 'mode', 'trigger_type', 'stage', 'resume_stage', 'scan', 'progress'];
  if (!object(errors, run, '$.run', new Set(runKeys), runKeys)) return;
  uuid(errors, run.run_id, '$.run.run_id'); nullable(errors, run.attempt_id, '$.run.attempt_id', uuid);
  enumValue(errors, run.mode, '$.run.mode', ['publish', 'dry_run']); enumValue(errors, run.trigger_type, '$.run.trigger_type', ['manual', 'daily', 'popup', 'cli']);
  enumValue(errors, run.stage, '$.run.stage', STAGES); enumValue(errors, run.resume_stage, '$.run.resume_stage', [null, ...STAGES]);
  validateScan(errors, run.scan, '$.run.scan');
  const p = run.progress;
  if (!object(errors, p, '$.run.progress', new Set(COUNT_KEYS), COUNT_KEYS)) return;
  for (const key of COUNT_KEYS) finiteInteger(errors, p[key], `$.run.progress.${key}`);
  if (p.selected !== p.selected_new + p.selected_updated + p.selected_missing_body || p.published > p.staged || p.staged > p.downloaded || p.downloaded > p.selected || p.indexed > p.selected || p.verified > p.indexed || p.verified > p.selected || p.downloaded !== p.fetched + p.reused) fail(errors, '$.run.progress', 'invalid progress ordering or totals');
  if (run.mode === 'dry_run' && (p.published || p.metadata_changed || p.verified || ['importing', 'indexing', 'final_verification', 'verified'].includes(run.stage))) fail(errors, '$.run', 'dry run cannot publish or verify');
  if (run.stage === 'verified' && (p.verified !== p.selected || p.indexed !== p.selected || run.scan?.coverage !== 'qualified_catalog_only' || value.blockers?.length)) fail(errors, '$.run', 'verified requires complete indexed and unblocked selected-version evidence');
  if (run.stage === 'dry_run_complete' && run.mode !== 'dry_run') fail(errors, '$.run.stage', 'requires dry-run mode');
}

export function validateStatus(value) { const errors = []; if (scanValues(errors, value)) validateStatusValue(errors, value); return result(errors, value); }
export const validateStatusSnapshot = validateStatus;

export function validateReceipt(value) {
  const errors = [];
  if (!scanValues(errors, value)) return result(errors, value);
  const allowed = new Set(['receipt_version', 'receipt_id', 'request_id', 'run_id', 'attempt_id', 'operation', 'outcome', 'observed_at', 'artifact', 'failure_code']);
  if (!object(errors, value, '$', allowed, [...allowed].slice(0, 8))) return result(errors, value);
  if (value.receipt_version !== RECEIPT_VERSION) fail(errors, '$.receipt_version', 'unsupported receipt version');
  uuid(errors, value.receipt_id, '$.receipt_id'); uuid(errors, value.request_id, '$.request_id'); uuid(errors, value.run_id, '$.run_id'); uuid(errors, value.attempt_id, '$.attempt_id'); enumValue(errors, value.operation, '$.operation', REQUEST_OPERATIONS); enumValue(errors, value.outcome, '$.outcome', ['accepted', 'rejected', 'failed', 'committed', 'blocked']); dateTime(errors, value.observed_at, '$.observed_at');
  if (value.artifact !== undefined) { const a = value.artifact; if (object(errors, a, '$.artifact', new Set(['artifact_id', 'raw_bytes', 'sha256']), ['artifact_id', 'raw_bytes', 'sha256'])) { uuid(errors, a.artifact_id, '$.artifact.artifact_id'); finiteInteger(errors, a.raw_bytes, '$.artifact.raw_bytes', 0, MAX_RESPONSE_BYTES); sha(errors, a.sha256, '$.artifact.sha256'); } }
  if (value.failure_code !== undefined) code(errors, value.failure_code, '$.failure_code');
  if (value.outcome === 'committed' && (value.operation !== 'commit_result' || value.artifact === undefined || value.failure_code !== undefined)) fail(errors, '$', 'committed result requires artifact evidence');
  if (['failed', 'rejected', 'blocked'].includes(value.outcome) && (value.failure_code === undefined || value.artifact !== undefined)) fail(errors, '$', 'failure requires a code and no artifact');
  if (value.outcome === 'accepted' && (value.artifact !== undefined || value.failure_code !== undefined)) fail(errors, '$', 'acceptance cannot imply artifact completion');
  if (value.operation === 'commit_result' && value.outcome !== 'committed' && !['failed', 'rejected', 'blocked'].includes(value.outcome)) fail(errors, '$', 'commit_result requires committed artifact evidence or a failure outcome');
  return result(errors, value);
}

export function assertValid(validation, label = 'value') {
  if (!validation?.ok) throw new TypeError(`Invalid ${label}: ${validation?.errors?.join('; ') || 'unknown validation error'}`);
  return validation.value;
}

export function assertValidRequest(value) { return assertValid(validateRequest(value), 'protocol request'); }
export function assertValidReply(value, op) { return assertValid(validateReply(value, op), 'protocol reply'); }
export function assertValidStatus(value) { return assertValid(validateStatus(value), 'status'); }
export function assertValidReceipt(value) { return assertValid(validateReceipt(value), 'receipt'); }
export const assertRequest = assertValidRequest;
export const assertReply = assertValidReply;
export const assertStatus = assertValidStatus;
export const assertReceipt = assertValidReceipt;
