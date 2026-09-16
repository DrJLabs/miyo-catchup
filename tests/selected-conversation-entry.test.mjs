import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { readSetupInspectionConfiguration } from '../src/setup-inspection-entry.mjs';
import { readSelectedConversationConfiguration } from '../src/selected-conversation-entry.mjs';
import { temporaryRoot } from './helpers/harness.mjs';

const binding = {
  binding_id: 'selected-binding', principal_id: 'selected-principal',
  context_id: 'selected-context', account_id: 'selected-account',
};

function fixture(t) {
  const root = temporaryRoot(t);
  const runtime = join(root, 'runtime');
  const staging = join(root, 'selected-staging');
  mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(staging, { mode: 0o700 });
  const nativePath = join(runtime, 'host.json');
  const configPath = join(runtime, 'selected.json');
  const socketPath = join(runtime, 'selected.sock');
  writeFileSync(nativePath, JSON.stringify({ version: 1, extension_id: 'a'.repeat(32), socket_path: socketPath }), { mode: 0o600 });
  const config = {
    version: 1, scope: 'background-selected-conversation', execution_context: 'extension-background',
    native_host_config: nativePath, root: staging, binding, conversation_id: 'selected-conversation',
  };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return { root, runtime, staging, nativePath, configPath, config };
}

test('selected-body configuration requires the explicit scope, background context, and non-null binding context', (t) => {
  const fixtureValue = fixture(t);
  const config = readSelectedConversationConfiguration(fixtureValue.configPath, { trustedBoundary: fixtureValue.root });
  assert.equal(config.scope, 'background-selected-conversation');
  assert.equal(config.execution_context, 'extension-background');
  assert.equal(config.root, fixtureValue.staging);
  assert.deepEqual(config.binding, binding);

  for (const mutate of [
    (value) => { value.scope = 'background-setup-inspection'; },
    (value) => { value.execution_context = 'page'; },
    (value) => { value.binding.context_id = null; },
    (value) => { value.scope = 'background-selected-conversation'; value.extra = true; },
  ]) {
    const changed = structuredClone(fixtureValue.config);
    mutate(changed);
    writeFileSync(fixtureValue.configPath, JSON.stringify(changed), { mode: 0o600 });
    assert.throws(() => readSelectedConversationConfiguration(fixtureValue.configPath, { trustedBoundary: fixtureValue.root }), {
      message: 'invalid_selected_configuration',
    });
  }
});

test('setup inspection parser refuses selected-body config instead of promoting the setup root', (t) => {
  const fixtureValue = fixture(t);
  assert.throws(() => readSetupInspectionConfiguration(fixtureValue.configPath, { trustedBoundary: fixtureValue.root }), {
    message: 'invalid_setup_configuration',
  });
});
