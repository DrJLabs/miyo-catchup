import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../extension/', import.meta.url);
const text = async (name) => readFile(new URL(name, root), 'utf8');

test('T02 package declares only bounded MV3 permissions and exact host scope', async () => {
  const manifest = JSON.parse(await text('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'nativeMessaging', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
  assert.equal(manifest.background.service_worker, 'background.mjs');
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(Object.hasOwn(manifest, 'externally_connectable'), false);
  assert.equal(Object.hasOwn(manifest, 'content_scripts'), false);
});

test('T02 package contains no automatic alarm/startup or remote-code hooks', async () => {
  const background = await text('background.mjs');
  const popup = await text('popup.mjs');
  assert.match(background, /installBackground/);
  assert.doesNotMatch(background, /alarms\.create|connectNative\(|tabs\.create\(/);
  assert.match(popup, /user_gesture: true/);
  assert.match(popup, /startup_status/);
  assert.match(popup, /diagnose_startup/);
  assert.match(popup, /background_status/);
  assert.match(popup, /inspect_background_session/);
  assert.doesNotMatch(popup, /eval\(|new Function\(|fetch\(/);
});

test('popup uses semantic controls and does not display configuration identifiers', async () => {
  const html = await text('popup.html');
  const popup = await text('popup.mjs');
  assert.match(html, /<main aria-labelledby="title">/);
  assert.match(html, /<p id="status" role="status" aria-live="polite">/);
  assert.match(html, /<button id="start" type="button" disabled>/);
  assert.match(html, /<button id="inspect-session" type="button" disabled>/);
  assert.match(html, /<button id="inspect-background-session" type="button" disabled>Inspect session in extension<\/button>/);
  assert.match(html, /<p id="background-status" role="status" aria-live="polite">/);
  assert.match(html, /<button id="diagnose-startup" type="button" disabled>Diagnose startup \(no fetch\)<\/button>/);
  assert.match(html, /<p id="startup-diagnostic-status" role="status" aria-live="polite">/);
  assert.match(html, /does not open a native connection or issue a collector fetch/);
  assert.doesNotMatch(popup, /conversation_id|principal_id|context_id|contract_fingerprint/);
});

test('public qualification config has no enabled account or context', async () => {
  const config = await text('qualification-config.mjs');
  assert.match(config, /export const setupConfig = undefined/);
  assert.match(config, /export const backgroundSetupConfig = undefined/);
  assert.match(config, /export const startupDiagnosticEnabled = false/);
  assert.match(config, /chatgpt-setup-2026-09-16/);
  assert.doesNotMatch(config, /browser_instance_id|conversation_id|principal_id|context_id/);
});
