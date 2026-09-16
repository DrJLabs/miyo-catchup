import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  constants as fsConstants,
} from 'node:fs';
import { assertSafePath, normalizeAbsolutePath } from './safe-paths.mjs';
import { jsonByteLength } from './framing.mjs';

export const CONFIG_VERSION = 1;

// These are policy literals.  Callers must persist them in a config file; they
// are never silently filled in by loadConfig or changed by runtime options.
export const DEFAULT_LIMITS = Object.freeze({
  active_collector_requests: 1,
  dispatch_spacing_ms: 5000,
  session_requests_per_attempt: 5,
  catalog_pages_per_attempt: 300,
  body_requests_per_attempt: 200,
  body_ids_per_request: 5,
  total_requests_per_attempt: 505,
  request_timeout_ms: 30000,
  permit_start_validity_ms: 5000,
  uncertain_grace_ms: 60000,
  collection_active_ms: 3600000,
  attempts_per_rolling_24h: 3,
  incomplete_scan_restart_age_ms: 21600000,
  cooldown_min_ms: 3600000,
  clock_discrepancy_ms: 60000,
  publication_batch: 10,
  index_poll_ms: 30000,
  worker_heartbeat_ms: 30000,
  status_stale_ms: 90000,
  index_no_progress_warning_ms: 1800000,
  index_no_progress_stop_ms: 21600000,
  private_artifact_bytes_per_run: 2147483648,
  daily_state_bytes: 10737418240,
  free_space_reserve_bytes: 2147483648,
  max_message_bytes: 262144,
  max_control_payload_bytes: 16384,
  max_raw_chunk_bytes: 184320,
  max_response_bytes: 67108864,
  max_cursor_bytes: 8192,
  max_unacknowledged_chunks: 2
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// SemVer 2.0.0: numeric core components and prerelease numeric identifiers
// cannot contain leading zeroes; build metadata is dot-separated and opaque.
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![\s\S])/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const ABSOLUTE_PATH = /^\/[^\u0000]*$/;
const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const TIMEZONE = /^[A-Za-z][A-Za-z0-9._+/-]{0,63}$/;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;

function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function add(errors, path, message) { errors.push(`${path}: ${message}`); }
function object(errors, value, path, allowed, required = []) {
  if (!plainObject(value)) { add(errors, path, 'must be an object'); return false; }
  for (const key of Object.keys(value)) if (!allowed.has(key)) add(errors, path, 'contains an unknown property');
  for (const key of required) if (!Object.hasOwn(value, key)) add(errors, `${path}.${key}`, 'is required');
  return true;
}
function text(errors, value, path, re, description) { if (typeof value !== 'string' || !re.test(value)) add(errors, path, description); }
function integer(errors, value, path, expected) { if (!Number.isSafeInteger(value) || value !== expected) add(errors, path, `must equal ${expected}`); }
function checkPath(errors, value, path) {
  text(errors, value, path, ABSOLUTE_PATH, 'must be an absolute path');
  if (typeof value !== 'string') return;
  if (value === '/') add(errors, path, 'must identify a private destination below the filesystem root');
  if (Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) add(errors, path, 'exceeds the path length limit');
  if (value.includes('/../') || value.endsWith('/..') || value.includes('//') || value.split('/').some((part) => part === '.' || part === '..')) add(errors, path, 'must not contain traversal or duplicate separators');
  try {
    if (normalizeAbsolutePath(value, 'configured root') !== value) add(errors, path, 'must be normalized');
  } catch { add(errors, path, 'is not a safe normalized absolute path'); }
}

export function validateConfig(value) {
  const errors = [];
  let bounded = true;
  try {
    jsonByteLength(value, MAX_CONFIG_BYTES);
  } catch {
    add(errors, '$', 'must be bounded inert JSON');
    bounded = false;
  }
  if (!bounded) return { ok: false, valid: false, errors: Object.freeze(errors) };
  const top = new Set(['config_version', 'binding', 'roots', 'versions', 'schedule', 'limits', 'state']);
  if (!object(errors, value, '$', top, [...top])) return { ok: false, valid: false, errors: Object.freeze(errors) };
  integer(errors, value.config_version, '$.config_version', CONFIG_VERSION);

  const bindingKeys = new Set(['binding_id', 'principal_id', 'context_id', 'account_id']);
  if (object(errors, value.binding, '$.binding', bindingKeys, [...bindingKeys])) for (const k of bindingKeys) text(errors, value.binding[k], `$.binding.${k}`, ID, 'must be a bounded identifier');

  const rootKeys = new Set(['release_root', 'extension_root', 'native_host_root', 'state_root', 'runtime_root', 'miyo_chats_root', 'miyo_manifest_path']);
  if (object(errors, value.roots, '$.roots', rootKeys, [...rootKeys])) for (const k of rootKeys) checkPath(errors, value.roots[k], `$.roots.${k}`);

  const versionKeys = new Set(['worker', 'extension', 'protocol', 'config', 'release_sha256', 'chatgpt_adapter', 'miyo_adapter', 'renderer']);
  if (object(errors, value.versions, '$.versions', versionKeys, [...versionKeys])) {
    text(errors, value.versions.worker, '$.versions.worker', VERSION, 'must be a semantic version');
    text(errors, value.versions.extension, '$.versions.extension', VERSION, 'must be a semantic version');
    integer(errors, value.versions.protocol, '$.versions.protocol', 1); integer(errors, value.versions.config, '$.versions.config', 1);
    for (const k of ['release_sha256', 'chatgpt_adapter', 'miyo_adapter', 'renderer']) text(errors, value.versions[k], `$.versions.${k}`, FINGERPRINT, 'must be a lowercase SHA-256 fingerprint');
  }

  const scheduleKeys = new Set(['enabled', 'timezone', 'local_time', 'persistent', 'randomized_delay_seconds', 'accuracy_seconds']);
  if (object(errors, value.schedule, '$.schedule', scheduleKeys, [...scheduleKeys])) {
    if (value.schedule.enabled !== false) add(errors, '$.schedule.enabled', 'must remain disabled until explicit activation');
    // The schema checks a bounded timezone token; Intl is the runtime
    // installation check that rejects an otherwise well-shaped unknown zone.
    text(errors, value.schedule.timezone, '$.schedule.timezone', TIMEZONE, 'must be a bounded timezone');
    text(errors, value.schedule.local_time, '$.schedule.local_time', TIME, 'must be HH:MM');
    if (value.schedule.persistent !== true) add(errors, '$.schedule.persistent', 'must be true');
    if (!Number.isSafeInteger(value.schedule.randomized_delay_seconds) || value.schedule.randomized_delay_seconds < 0 || value.schedule.randomized_delay_seconds > 86400) add(errors, '$.schedule.randomized_delay_seconds', 'must be a safe integer from 0 to 86400');
    if (!Number.isSafeInteger(value.schedule.accuracy_seconds) || value.schedule.accuracy_seconds < 1 || value.schedule.accuracy_seconds > 3600) add(errors, '$.schedule.accuracy_seconds', 'must be a safe integer from 1 to 3600');
    if (typeof value.schedule.timezone === 'string') try { new Intl.DateTimeFormat('en-US', { timeZone: value.schedule.timezone }); } catch { add(errors, '$.schedule.timezone', 'is not an installed IANA timezone'); }
  }

  const limitKeys = new Set(Object.keys(DEFAULT_LIMITS));
  if (object(errors, value.limits, '$.limits', limitKeys, [...limitKeys])) for (const [key, expected] of Object.entries(DEFAULT_LIMITS)) integer(errors, value.limits[key], `$.limits.${key}`, expected);

  const stateKeys = new Set(['namespace', 'owner']);
  if (object(errors, value.state, '$.state', stateKeys, [...stateKeys])) { if (value.state.namespace !== 'daily') add(errors, '$.state.namespace', 'must be daily'); if (value.state.owner !== 'miyo-chatgpt-catchup') add(errors, '$.state.owner', 'must be miyo-chatgpt-catchup'); }
  return { ok: errors.length === 0, valid: errors.length === 0, errors: Object.freeze(errors), value: errors.length === 0 ? value : undefined };
}

export function assertValidConfig(value) {
  const checked = validateConfig(value);
  if (!checked.ok) throw new TypeError(`Invalid configuration: ${checked.errors.join('; ')}`);
  return checked.value;
}

export function parseConfig(text) {
  if (typeof text !== 'string' || text.length === 0) throw new TypeError('Configuration text is required');
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) throw new TypeError('Configuration exceeds the size limit');
  let value;
  try { value = JSON.parse(text); } catch { throw new TypeError('Configuration is not valid JSON'); }
  try { jsonByteLength(value, MAX_CONFIG_BYTES); } catch { throw new TypeError('Configuration is not bounded inert JSON'); }
  return assertValidConfig(value);
}

/** Load only the explicitly supplied file. There is intentionally no default path. */
export function loadConfig(configPath, { trustedBoundary = undefined } = {}) {
  if (typeof configPath !== 'string' || configPath.length === 0) throw new TypeError('An explicit configuration path is required');
  let normalized;
  try {
    normalized = assertSafePath(configPath, { label: 'configuration file', expectedType: 'file', privateMode: true, trustedBoundary });
  } catch {
    throw new TypeError('Configuration path is not a safe private regular file');
  }
  let descriptor;
  try {
    descriptor = openSync(normalized, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    const ownerUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.uid !== ownerUid || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new TypeError('Configuration file is not a private regular file');
    if (stat.size > MAX_CONFIG_BYTES) throw new TypeError('Configuration file exceeds the size limit');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const n = readSync(descriptor, buffer, count, buffer.length - count, null);
      if (n === 0) break;
      count += n;
    }
    if (count > MAX_CONFIG_BYTES) throw new TypeError('Configuration file exceeds the size limit');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, count)); }
    catch { throw new TypeError('Configuration is not valid UTF-8'); }
    return parseConfig(text);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
