// Test-only interpreter for the keywords used by these four checked-in schemas.
// It is deliberately not shipped as a runtime schema engine or public library.
import assert from 'node:assert/strict';

const keywords = new Set(['$schema', '$id', 'title', 'description', '$defs', '$ref', 'type', 'const', 'enum', 'allOf', 'anyOf', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'uniqueItems', 'minItems', 'maxItems', 'pattern', 'format', 'minLength', 'maxLength', 'minimum', 'maximum', 'contentEncoding']);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function schemaConforms(schema, value, { documents = {} } = {}) {
  function check(s, v, root = schema) {
    if (typeof s === 'boolean') return s;
    for (const key of Object.keys(s)) assert.ok(keywords.has(key), `unimplemented test schema keyword: ${key}`);
    if (s.$ref) {
      const [file, fragment = ''] = s.$ref.split('#');
      const document = file ? documents[file] : root;
      assert.ok(document, 'missing test schema document');
      const target = fragment ? fragment.slice(1).split('/').reduce((node, key) => node?.[key], document) : document;
      assert.ok(target, 'missing test schema reference');
      if (!check(target, v, document)) return false;
    }
    if (s.allOf && !s.allOf.every((part) => check(part, v, root))) return false;
    if (s.anyOf && !s.anyOf.some((part) => check(part, v, root))) return false;
    if (s.oneOf && s.oneOf.filter((part) => check(part, v, root)).length !== 1) return false;
    if (Object.hasOwn(s, 'const') && !equal(s.const, v)) return false;
    if (s.enum && !s.enum.some((item) => equal(item, v))) return false;
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      const match = (type) => type === 'null' ? v === null : type === 'array' ? Array.isArray(v) : type === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : type === 'integer' ? Number.isInteger(v) : type === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === type;
      if (!types.some(match)) return false;
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      if (s.required?.some((key) => !Object.hasOwn(v, key))) return false;
      if (s.additionalProperties === false && Object.keys(v).some((key) => !Object.hasOwn(s.properties ?? {}, key))) return false;
      if (Object.entries(s.properties ?? {}).some(([key, part]) => Object.hasOwn(v, key) && !check(part, v[key], root))) return false;
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) return false;
      if (s.maxItems !== undefined && v.length > s.maxItems) return false;
      if (s.uniqueItems && new Set(v.map((item) => JSON.stringify(item))).size !== v.length) return false;
      if (s.items && !v.every((item) => check(s.items, item, root))) return false;
    }
    if (typeof v === 'string') {
      if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) return false;
      if (s.minLength !== undefined && [...v].length < s.minLength) return false;
      if (s.maxLength !== undefined && [...v].length > s.maxLength) return false;
      if (s.format === 'date-time' && (!Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 19) !== v.slice(0, 19))) return false;
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) return false;
      if (s.maximum !== undefined && v > s.maximum) return false;
    }
    return true;
  }
  return check(schema, value);
}
