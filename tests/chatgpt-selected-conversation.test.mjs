import assert from 'node:assert/strict';
import test from 'node:test';
import { selectedConversationRequest, validateSelectedConversation } from '../adapters/chatgpt-selected-conversation.mjs';

const conversationId = 'synthetic-selected-conversation';
function conversation() {
  return {
    conversation_id: conversationId, title: 'Synthetic branch test',
    create_time: 1_700_000_000, update_time: 1_700_000_050.25,
    current_node: 'assistant-node',
    mapping: {
      'root-node': { id: 'root-node', parent: null, children: ['user-node'], message: null },
      'user-node': { id: 'user-node', parent: 'root-node', children: ['assistant-node', 'alternate-node'],
        message: { id: 'user-message', author: { role: 'user' },
          content: { content_type: 'text', parts: ['Synthetic prompt'] } } },
      'assistant-node': { id: 'assistant-node', parent: 'user-node', children: [],
        message: { id: 'assistant-message', author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Synthetic answer'] } } },
      'alternate-node': { id: 'alternate-node', parent: 'user-node', children: [],
        message: { id: 'alternate-message', author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Synthetic alternate answer'] } } },
    },
  };
}

test('draft route is fixed to one selected ID and cannot be turned into a batch/catalog request', () => {
  assert.deepEqual(selectedConversationRequest(conversationId), {
    method: 'GET', url: 'https://chatgpt.com/backend-api/conversation/synthetic-selected-conversation',
  });
  assert.equal(Object.isFrozen(selectedConversationRequest(conversationId)), true);
  for (const id of ['', null, [], {}, '../conversations', 'id?offset=0', 'a/b', 'a#fragment',
    'https://example.invalid', 'a'.repeat(129), ' leading', 'line\nbreak']) {
    assert.throws(() => selectedConversationRequest(id), {
      name: 'TypeError', message: 'invalid_selected_conversation',
    });
  }
  assert.equal(selectedConversationRequest('safe:synthetic').url.endsWith('safe%3Asynthetic'), true);
});

test('accepts one complete selected conversation including alternate branches without returning content', () => {
  const value = conversation();
  const before = structuredClone(value);
  assert.equal(validateSelectedConversation(value, conversationId), true);
  assert.deepEqual(value, before);
  value.metadata = { unknown_future_field: { opaque: true } };
  value.mapping['assistant-node'].message.metadata = { opaque: true };
  assert.equal(validateSelectedConversation(value, conversationId), true);
  value.current_node = 'alternate-node';
  assert.equal(validateSelectedConversation(value, conversationId), true);
});

test('rejects another ID, batch/auth envelopes, missing contract fields and invalid versions', () => {
  for (const mutate of [
    (v) => { v.conversation_id = 'different-conversation'; },
    (v) => { delete v.conversation_id; v.id = conversationId; },
    (v) => { v.title = null; },
    (v) => { v.title = 'x'.repeat(65_537); },
    (v) => { v.create_time = '1700000000'; },
    (v) => { v.update_time = null; },
    (v) => { v.update_time = Infinity; },
    (v) => { v.update_time = 1; },
    (v) => { v.update_time = 8_640_000_000_001; },
    (v) => { v.current_node = 'missing-node'; },
    (v) => { v.mapping = []; },
    (v) => { v.mapping = {}; },
  ]) {
    const value = conversation(); mutate(value);
    assert.equal(validateSelectedConversation(value, conversationId), false);
  }
  for (const key of ['accessToken', 'access_token', 'refresh_token', 'id_token', 'authorization', 'cookie', 'cookies']) {
    assert.equal(validateSelectedConversation({ ...conversation(), [key]: 'private-sentinel' }, conversationId), false);
  }
  assert.equal(validateSelectedConversation({ conversations: [conversation()] }, conversationId), false);
  assert.equal(validateSelectedConversation(conversation(), 'different-selection'), false);
  assert.equal(validateSelectedConversation(conversation(), null), false);
});

test('rejects partial, cyclic, inconsistent and duplicated graph relationships', () => {
  for (const mutate of [
    (v) => { v.mapping['user-node'].id = 'wrong-node'; },
    (v) => { v.mapping['user-node'].parent = 'missing-node'; },
    (v) => { v.mapping['user-node'].parent = 'user-node'; },
    (v) => { v.mapping['root-node'].parent = 'assistant-node'; v.mapping['assistant-node'].children = ['root-node']; },
    (v) => { v.mapping['alternate-node'].parent = null; },
    (v) => { v.mapping['user-node'].children = ['assistant-node', 'assistant-node']; },
    (v) => { v.mapping['user-node'].children = ['missing-node']; },
    (v) => { v.mapping['user-node'].children = ['user-node']; },
    (v) => { v.mapping['user-node'].children = ['assistant-node']; },
    (v) => { v.mapping['alternate-node'].parent = 'root-node'; },
    (v) => { delete v.mapping['alternate-node']; },
    (v) => { delete v.mapping['root-node'].parent; },
    (v) => { delete v.mapping['root-node'].message; },
  ]) {
    const value = conversation(); mutate(value);
    assert.equal(validateSelectedConversation(value, conversationId), false);
  }
});

test('rejects a detached cycle even when the root component and edge count look valid', () => {
  const value = conversation();
  value.mapping['user-node'].children = ['assistant-node'];
  value.mapping['alternate-node'].parent = 'detached-node';
  value.mapping['alternate-node'].children = ['detached-node'];
  value.mapping['detached-node'] = { id: 'detached-node', parent: 'alternate-node',
    children: ['alternate-node'], message: null };
  assert.equal(validateSelectedConversation(value, conversationId), false);
});

test('malformed message structure and accessors fail without evaluating code', () => {
  for (const mutate of [
    (v) => { v.mapping['user-node'].message = []; },
    (v) => { v.mapping['user-node'].message.id = null; },
    (v) => { v.mapping['user-node'].message.author = null; },
    (v) => { v.mapping['user-node'].message.author.role = {}; },
    (v) => { v.mapping['user-node'].message.content = null; },
  ]) {
    const value = conversation(); mutate(value);
    assert.equal(validateSelectedConversation(value, conversationId), false);
  }
  let executed = false;
  const value = conversation();
  Object.defineProperty(value, 'conversation_id', { enumerable: true, get() { executed = true; throw new Error('private-sentinel'); } });
  assert.equal(validateSelectedConversation(value, conversationId), false);
  assert.equal(executed, false);
  assert.equal(validateSelectedConversation(Object.create(conversation()), conversationId), false);
});

test('validation is iterative and bounded for deep and oversized mappings', () => {
  const value = conversation();
  value.mapping = {};
  const count = 12_000;
  for (let i = 0; i < count; i++) value.mapping['node-'+i] = {
    id: 'node-'+i, parent: i ? 'node-'+(i-1) : null,
    children: i < count-1 ? ['node-'+(i+1)] : [], message: null,
  };
  value.current_node = 'node-'+(count-1);
  assert.equal(validateSelectedConversation(value, conversationId), true);
  for (let i = count; i < 100_001; i++) value.mapping['node-'+i] = null;
  assert.equal(validateSelectedConversation(value, conversationId), false);
});

test('offline contract has no ambient fetch, storage, native or browser effects', () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail('draft contract must never fetch');
  try {
    assert.equal(validateSelectedConversation(conversation(), conversationId), true);
    assert.equal(selectedConversationRequest(conversationId).method, 'GET');
  } finally { globalThis.fetch = original; }
});
