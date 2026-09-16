import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_LIMITS, loadConfig, parseConfig, validateConfig } from '../src/config.mjs';
import { schemaConforms } from './helpers/schema-check.mjs';

const schema = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../schemas/config-v1.json', import.meta.url), 'utf8'));

function fixture() {
  return {
    config_version: 1,
    binding: { binding_id: 'binding-1', principal_id: 'principal-1', context_id: 'personal-default', account_id: 'account-1' },
    roots: {
      release_root: '/srv/miyo/releases', extension_root: '/srv/miyo/extension', native_host_root: '/srv/miyo/native',
      state_root: '/srv/miyo/state', runtime_root: '/run/user/1000/miyo', miyo_chats_root: '/srv/miyo/chats', miyo_manifest_path: '/srv/miyo/manifest.json'
    },
    versions: { worker: '1.0.0', extension: '1.0.0', protocol: 1, config: 1, release_sha256: 'd'.repeat(64), chatgpt_adapter: 'a'.repeat(64), miyo_adapter: 'b'.repeat(64), renderer: 'c'.repeat(64) },
    schedule: { enabled: false, timezone: 'America/New_York', local_time: '04:00', persistent: true, randomized_delay_seconds: 600, accuracy_seconds: 60 },
    limits: { ...DEFAULT_LIMITS },
    state: { namespace: 'daily', owner: 'miyo-chatgpt-catchup' }
  };
}

test('config v1 accepts an explicit complete inert configuration', () => {
  const value = fixture();
  assert.equal(validateConfig(value).ok, true);
  assert.equal(schemaConforms(schema, value), true);
  assert.deepEqual(parseConfig(JSON.stringify(value)), value);
});

test('inert preflight returns before invoking accessors', () => {
  let touched = false;
  const hostile = {};
  Object.defineProperty(hostile, 'binding', {
    enumerable: true,
    get() {
      touched = true;
      throw new Error('accessor must not run');
    }
  });
  const checked = validateConfig(hostile);
  assert.equal(checked.ok, false);
  assert.equal(touched, false);
});

test('every fixed limit is present and cannot be overridden', () => {
  const value = fixture();
  assert.equal(value.limits.clock_discrepancy_ms, 60000);
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const changed = fixture();
    changed.limits[key] = changed.limits[key] + 1;
    assert.equal(validateConfig(changed).ok, false, key);
    assert.equal(schemaConforms(schema, changed), false, key);
  }
});

test('roots require bounded normalized absolute paths and reject traversal or unknown fields', () => {
  for (const root of ['/', '//state', '/./state', '/../state', '/srv/miyo/../other', '/srv/miyo//state', '/srv/miyo/./state', `${'/srv/miyo/'.repeat(600)}state`]) {
    const value = fixture(); value.roots.state_root = root;
    assert.equal(validateConfig(value).ok, false, root.slice(0, 40));
    assert.equal(schemaConforms(schema, value), false);
  }
  const value = fixture(); value.roots.extra = '/srv/miyo/extra';
  assert.equal(validateConfig(value).ok, false);
  const blank = fixture(); blank.binding.account_id = '';
  assert.equal(validateConfig(blank).ok, false);
});

test('schedule stays disabled and runtime timezone validity is checked', () => {
  const enabled = fixture(); enabled.schedule.enabled = true;
  assert.equal(validateConfig(enabled).ok, false);
  const unknown = fixture(); unknown.schedule.timezone = 'Mars/Phobos';
  assert.equal(validateConfig(unknown).ok, false);
  const malformed = fixture(); malformed.schedule.local_time = '4:00';
  assert.equal(validateConfig(malformed).ok, false);
});

test('explicit load is bounded, private, and does not follow a config symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'miyo-config-test-'));
  chmodSync(root, 0o700);
  try {
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify(fixture()), { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.deepEqual(loadConfig(path, { trustedBoundary: root }), fixture());
    const link = join(root, 'link.json');
    symlinkSync(path, link);
    assert.throws(() => loadConfig(link, { trustedBoundary: root }), /safe private regular file/);
    writeFileSync(path, Buffer.from([0xc0, 0xaf]));
    assert.throws(() => loadConfig(path, { trustedBoundary: root }), /valid UTF-8/);
    writeFileSync(path, 'x'.repeat(70 * 1024), { mode: 0o600 });
    assert.throws(() => loadConfig(path, { trustedBoundary: root }), /size limit|not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema parity covers all config keys and strict objects', () => {
  assert.equal(schema.$id.endsWith('/config-v1.json'), true);
  assert.equal(schema.properties.config_version.const, 1);
  assert.deepEqual(Object.keys(schema.properties.limits.properties).sort(), Object.keys(DEFAULT_LIMITS).sort());
  assert.deepEqual(schema.properties.limits.required.sort(), Object.keys(DEFAULT_LIMITS).sort());
  const strictObjects = [];
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'object') strictObjects.push(value.additionalProperties === false);
    for (const child of Object.values(value)) walk(child);
  };
  walk(schema);
  assert.ok(strictObjects.length > 0 && strictObjects.every(Boolean));
});
