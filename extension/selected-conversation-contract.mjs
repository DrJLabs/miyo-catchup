// Fixed selected-response contract shared by the separately gated browser proof
// and private receiver. Pure validation is not evidence of live qualification.
// Callers must first enforce the existing 64 MiB byte cap and strict UTF-8 JSON
// decoding. This checks identity/topology, not rendering or workspace ownership.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_NODES = 100_000;
const MAX_TITLE_CHARS = 65_536;
const MAX_EPOCH_SECONDS = 8_640_000_000_000;
// Top-level authentication envelopes are not conversation metadata. Fold case,
// compatibility characters and separators before rejecting credential families;
// a renamed envelope must not pass merely because it is not an exact spelling.
const AUTH_ENVELOPE_KEY = /auth|token|credential|cookie|password|passwd|secret|apikey|privatekey|session/;

function credentialEnvelopeKey(key) {
  return AUTH_ENVELOPE_KEY.test(key.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function identifier(value) { return typeof value === 'string' && ID.test(value); }

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && Object.hasOwn(descriptor, 'value')
      && descriptor.enumerable;
  });
}

function timestamp(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= MAX_EPOCH_SECONDS;
}

/** Fixed route only; this descriptor grants no fetch or authentication authority. */
export function selectedConversationRequest(conversationId) {
  if (!identifier(conversationId)) throw new TypeError('invalid_selected_conversation');
  return Object.freeze({
    method: 'GET',
    url: `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(conversationId)}`,
  });
}

/**
 * Validate parsed inert JSON without returning content or remote error text.
 * Optional metadata is opaque: accepting it does not qualify its interpretation.
 * Requiring a complete connected tree prevents partial/ambiguous mappings from
 * being mistaken for a complete selected-conversation artifact.
 */
export function validateSelectedConversation(value, expectedConversationId) {
  try {
    if (!identifier(expectedConversationId) || !record(value)
      || Object.keys(value).some(credentialEnvelopeKey)
      || value.conversation_id !== expectedConversationId
      || typeof value.title !== 'string' || value.title.length > MAX_TITLE_CHARS
      || !timestamp(value.create_time) || !timestamp(value.update_time)
      || value.update_time < value.create_time
      || !record(value.mapping) || !identifier(value.current_node)) return false;

    const entries = Object.entries(value.mapping);
    if (entries.length < 1 || entries.length > MAX_NODES
      || !Object.hasOwn(value.mapping, value.current_node)) return false;
    const nodes = new Map(entries);
    const childSets = new Map();
    let root = null;
    let edgeCount = 0;
    for (const [id, node] of entries) {
      if (!identifier(id) || !record(node) || node.id !== id
        || !Object.hasOwn(node, 'parent') || !Object.hasOwn(node, 'message')
        || !Array.isArray(node.children) || node.children.length >= entries.length) return false;
      if (node.parent === null) {
        if (root !== null) return false;
        root = id;
      } else if (!identifier(node.parent) || node.parent === id || !nodes.has(node.parent)) return false;
      const children = new Set();
      for (const child of node.children) {
        if (!identifier(child) || child === id || !nodes.has(child) || children.has(child)) return false;
        children.add(child);
      }
      edgeCount += children.size;
      if (edgeCount >= entries.length) return false;
      childSets.set(id, children);
      if (node.message !== null) {
        const message = node.message;
        if (!record(message) || !identifier(message.id) || !record(message.author)
          || !identifier(message.author.role) || !record(message.content)) return false;
        // Content/metadata formats are not rendered, executed, or dereferenced.
        // Their compatibility is a later importer contract, not this body proof.
      }
    }
    if (root === null || edgeCount !== entries.length - 1) return false;
    for (const [id, node] of entries) {
      if (node.parent !== null && !childSets.get(node.parent).has(id)) return false;
      for (const child of childSets.get(id)) if (nodes.get(child).parent !== id) return false;
    }
    const visited = new Set();
    const pending = [root];
    while (pending.length) {
      const id = pending.pop();
      if (visited.has(id)) return false;
      visited.add(id);
      for (const child of childSets.get(id)) pending.push(child);
    }
    return visited.size === entries.length;
  } catch {
    return false;
  }
}
