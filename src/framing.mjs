import { endianness } from 'node:os';

export const MAX_MESSAGE_BYTES = 262_144;
const littleEndian = endianness() === 'LE';

export class FrameError extends Error {
  constructor(code) {
    super(code);
    this.name = 'FrameError';
    this.code = code;
  }
}

// Count JSON's UTF-8 representation without first creating an unbounded string.
// Accept only inert JSON values: no getters, custom prototypes or toJSON hooks.
export function jsonByteLength(value, limit = MAX_MESSAGE_BYTES) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MESSAGE_BYTES) {
    throw new FrameError('invalid_limit');
  }
  let size = 0;
  const active = new Set();
  const add = (bytes) => {
    size += bytes;
    if (size > limit) throw new FrameError('message_too_large');
  };
  function stringSize(text) {
    add(2);
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code === 0x22 || code === 0x5c || [8, 9, 10, 12, 13].includes(code)) add(2);
      else if (code < 0x20) add(6);
      else if (code < 0x80) add(1);
      else if (code < 0x800) add(2);
      else if (code >= 0xd800 && code <= 0xdbff
        && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
        add(4);
        i += 1;
      } else if (code >= 0xd800 && code <= 0xdfff) add(6);
      else add(3);
    }
  }
  function visit(item, depth) {
    if (depth > 64) throw new FrameError('json_too_deep');
    if (item === null) { add(4); return; }
    if (typeof item === 'string') { stringSize(item); return; }
    if (typeof item === 'boolean') { add(item ? 4 : 5); return; }
    if (typeof item === 'number' && Number.isFinite(item)) {
      add(String(item).length);
      return;
    }
    if (typeof item !== 'object' || active.has(item)) throw new FrameError('invalid_json');
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype)
      && !(Object.getPrototypeOf(item) === null && !array)) throw new FrameError('invalid_json');
    active.add(item);
    add(2);
    if (array) {
      // An array's minimum representation is already enough to reject huge lengths.
      if (item.length > limit) throw new FrameError('message_too_large');
      if (Reflect.ownKeys(item).length !== item.length + 1) throw new FrameError('invalid_json');
      for (let i = 0; i < item.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !('value' in descriptor)) throw new FrameError('invalid_json');
        if (i) add(1);
        visit(descriptor.value, depth + 1);
      }
    } else {
      let count = 0;
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) {
          throw new FrameError('invalid_json');
        }
        if (count++) add(1);
        stringSize(key);
        add(1);
        visit(descriptor.value, depth + 1);
      }
    }
    active.delete(item);
  }
  visit(value, 0);
  return size;
}

export function encodeNativeMessage(message, validate) {
  if (typeof validate !== 'function') throw new FrameError('validator_required');
  const bytes = jsonByteLength(message);
  try {
    validate(message);
  } catch {
    throw new FrameError('frame_rejected');
  }
  const frame = Buffer.allocUnsafe(4 + bytes);
  if (littleEndian) frame.writeUInt32LE(bytes, 0);
  else frame.writeUInt32BE(bytes, 0);
  frame.write(JSON.stringify(message), 4, bytes, 'utf8');
  return frame;
}

// One bounded frame buffer and one awaited consumer. Input must be pulled from
// the stream only after consume resolves; never attach an async 'data' listener.
export class NativeFrameDecoder {
  #header = Buffer.alloc(4);
  #headerBytes = 0;
  #body = null;
  #bodyBytes = 0;
  #busy = false;
  #closed = false;
  #validate;

  constructor(validate) {
    if (typeof validate !== 'function') throw new FrameError('validator_required');
    this.#validate = validate;
  }

  get bufferedBytes() { return this.#headerBytes + this.#bodyBytes; }
  get allocatedBodyBytes() { return this.#body?.length ?? 0; }

  async consume(chunk, accept) {
    if (this.#closed) throw new FrameError('decoder_closed');
    if (this.#busy) throw new FrameError('concurrent_consume');
    if (!Buffer.isBuffer(chunk) || typeof accept !== 'function') throw new FrameError('invalid_input');
    this.#busy = true;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.#body === null) {
          const count = Math.min(4 - this.#headerBytes, chunk.length - offset);
          chunk.copy(this.#header, this.#headerBytes, offset, offset + count);
          this.#headerBytes += count;
          offset += count;
          if (this.#headerBytes < 4) continue;
          const length = littleEndian ? this.#header.readUInt32LE() : this.#header.readUInt32BE();
          if (!length || length > MAX_MESSAGE_BYTES) throw new FrameError('invalid_frame_length');
          this.#body = Buffer.allocUnsafe(length);
        }
        const count = Math.min(this.#body.length - this.#bodyBytes, chunk.length - offset);
        chunk.copy(this.#body, this.#bodyBytes, offset, offset + count);
        this.#bodyBytes += count;
        offset += count;
        if (this.#bodyBytes !== this.#body.length) continue;
        let message;
        try {
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.#body);
          message = JSON.parse(text);
        } catch {
          throw new FrameError('invalid_frame_json');
        }
        jsonByteLength(message);
        try {
          this.#validate(message);
        } catch {
          throw new FrameError('frame_rejected');
        }
        this.#body = null;
        this.#bodyBytes = 0;
        this.#headerBytes = 0;
        try {
          await accept(message);
        } catch {
          throw new FrameError('frame_rejected');
        }
      }
    } catch (error) {
      this.#closed = true;
      this.#body = null;
      this.#bodyBytes = 0;
      this.#headerBytes = 0;
      // Validator/consumer errors are not forwarded as arbitrary diagnostics.
      throw error instanceof FrameError ? error : new FrameError('frame_rejected');
    } finally {
      this.#busy = false;
    }
  }

  finish() {
    if (this.#closed) throw new FrameError('decoder_closed');
    if (this.#busy) throw new FrameError('concurrent_consume');
    this.#closed = true;
    if (this.bufferedBytes) {
      this.#body = null;
      this.#bodyBytes = 0;
      this.#headerBytes = 0;
      throw new FrameError('truncated_frame');
    }
  }
}
