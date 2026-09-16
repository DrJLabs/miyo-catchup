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
  assert.doesNotMatch(popup, /eval\(|new Function\(|fetch\(/);
});

test('popup uses semantic controls and does not display configuration identifiers', async () => {
  const html = await text('popup.html');
  const popup = await text('popup.mjs');
  assert.match(html, /<main aria-labelledby="title">/);
  assert.match(html, /<p id="status" role="status" aria-live="polite">/);
  assert.match(html, /<button id="start" type="button" disabled>/);
  assert.doesNotMatch(popup, /conversation_id|principal_id|context_id|contract_fingerprint/);
});
