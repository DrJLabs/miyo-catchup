import { createNativeClient } from './probe-client.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const NULL_FIELDS = ['run', 'last_complete_scan', 'last_fully_verified_run',
  'receipt_evidence_at', 'next_scheduled_due_at', 'cooldown_until', 'retry_at'];
const BUDGET_KEYS = ['session_requests', 'catalog_pages', 'body_requests', 'total_requests', 'attempts'];
const STATUS_KEYS = ['status_version', 'generated_at', 'worker_instance_id', 'worker_version',
  'connectivity', 'liveness', 'heartbeat_at', 'blockers', 'primary_blocker',
  'pause_requested', 'paused_at_safe_boundary', 'budget_remaining', 'error_code', ...NULL_FIELDS];

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// This deliberately recognizes only the capture-disabled connection endpoint,
// not arbitrary worker status or a successful qualification/capture claim.
export function isConnectionCheckReply(reply, requestId, now = Date.now()) {
  if (!exact(reply, ['protocol_version', 'request_id', 'ok', 'result'])
    || reply.protocol_version !== 1 || reply.request_id !== requestId || reply.ok !== true
    || !exact(reply.result, ['status'])) return false;
  const s = reply.result.status;
  if (!exact(s, STATUS_KEYS) || s.status_version !== 1
    || typeof s.worker_instance_id !== 'string' || !UUID.test(s.worker_instance_id)
    || s.worker_version !== '0.0.0-t02-connection'
    || s.connectivity !== 'available' || s.liveness !== 'live'
    || s.pause_requested !== false || s.paused_at_safe_boundary !== false
    || s.primary_blocker !== 'blocked' || s.error_code !== 'blocked'
    || !Array.isArray(s.blockers) || s.blockers.length !== 1 || s.blockers[0] !== 'blocked'
    || NULL_FIELDS.some((key) => s[key] !== null)
    || !exact(s.budget_remaining, BUDGET_KEYS)
    || BUDGET_KEYS.some((key) => s.budget_remaining[key] !== 0)
    || typeof s.generated_at !== 'string' || !DATE.test(s.generated_at)
    || s.heartbeat_at !== s.generated_at) return false;
  const stamp = Date.parse(s.generated_at);
  if (!Number.isFinite(stamp)
    || new Date(stamp).toISOString().slice(0, 19) !== s.generated_at.slice(0, 19)) return false;
  const age = now - stamp;
  return Number.isFinite(age) && age >= -5000 && age <= 30000;
}

export function connectionResult(state) {
  return { type: 'connection_check', state };
}

/** One explicit local-only read, no storage, tab, lease, permit, or retry. */
export async function checkNativeConnection({ chromeApi, makeNativeClient = createNativeClient,
  uuid = () => crypto.randomUUID(), now = () => Date.now() } = {}) {
  let client;
  try {
    const requestId = uuid();
    if (typeof requestId !== 'string' || !UUID.test(requestId)) return connectionResult('incompatible');
    client = makeNativeClient(chromeApi, { timeoutMs: 10000 });
    const reply = await client.request({ protocol_version: 1, request_id: requestId,
      operation: 'get_status', payload: {} });
    return connectionResult(isConnectionCheckReply(reply, requestId, now()) ? 'passed' : 'incompatible');
  } catch {
    return connectionResult('unavailable');
  } finally {
    try { client?.close?.(); } catch { /* Never expose native diagnostics. */ }
  }
}
