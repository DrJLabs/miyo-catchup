import { randomUUID } from 'node:crypto';

import {
  assertReply,
  assertRequest,
  assertStatus,
} from './contracts.mjs';

export const CONNECTION_CHECK_WORKER_VERSION = '0.0.0-t02-connection';

const BUDGET_KEYS = Object.freeze([
  'session_requests',
  'catalog_pages',
  'body_requests',
  'total_requests',
  'attempts',
]);

function blocked(requestId) {
  return {
    protocol_version: 1,
    request_id: requestId,
    ok: false,
    error: { code: 'blocked' },
  };
}

function statusFor(workerInstanceId, now) {
  const generatedAt = new Date(now).toISOString();
  const budgetRemaining = Object.fromEntries(BUDGET_KEYS.map((key) => [key, 0]));
  const status = {
    status_version: 1,
    generated_at: generatedAt,
    worker_instance_id: workerInstanceId,
    worker_version: CONNECTION_CHECK_WORKER_VERSION,
    connectivity: 'available',
    liveness: 'live',
    heartbeat_at: generatedAt,
    run: null,
    blockers: ['blocked'],
    primary_blocker: 'blocked',
    pause_requested: false,
    paused_at_safe_boundary: false,
    last_complete_scan: null,
    last_fully_verified_run: null,
    receipt_evidence_at: null,
    next_scheduled_due_at: null,
    cooldown_until: null,
    retry_at: null,
    budget_remaining: budgetRemaining,
    error_code: 'blocked',
  };
  return assertStatus(status);
}

/**
 * A transport-only receiver for the private T02 connection check.
 *
 * It intentionally has no durable state, storage, browser, Miyo or network
 * dependencies. One receiver instance owns one process identity; every
 * accepted request generates a fresh current heartbeat.
 */
export function createConnectionCheckReceiver({
  workerInstanceId = randomUUID(),
  now = () => Date.now(),
} = {}) {
  let requestCount = 0;
  const handle = (message) => {
    const request = assertRequest(message);
    requestCount += 1;

    // Only the global form is a connection check. A valid scoped status
    // request, hello, or any other valid protocol operation is deliberately
    // refused without touching any external state.
    if (request.operation !== 'get_status' || Object.keys(request.payload).length !== 0) {
      return assertReply(blocked(request.request_id), request.operation);
    }

    const status = statusFor(workerInstanceId, now());
    return assertReply({
      protocol_version: 1,
      request_id: request.request_id,
      ok: true,
      result: { status },
    }, 'get_status');
  };

  return Object.freeze({
    request: handle,
    handle,
    get requestCount() { return requestCount; },
  });
}
