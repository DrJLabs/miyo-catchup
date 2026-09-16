import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { endianness } from 'node:os';
import test from 'node:test';
import { FrameError, MAX_MESSAGE_BYTES, NativeFrameDecoder, encodeNativeMessage, jsonByteLength } from '../src/framing.mjs';
import { FakeClock, FakeTransport } from './helpers/harness.mjs';

const validate = (value) => assert.equal(typeof value.text, 'string');
function rawFrame(body) {
  const head = Buffer.alloc(4);
  head[endianness() === 'LE' ? 'writeUInt32LE' : 'writeUInt32BE'](body.length);
  return Buffer.concat([head, body]);
}

test('AC13 JSON byte counting agrees on escaping, Unicode, lone surrogates and numbers', () => {
  for (const value of [null, true, false, 0, -0, 1e24, 0.000002, [], {},
    { text: 'café 漢字 😀 \\ "\n\t\b\f\r\u0000\ud800\udc00\udfff\ud800' }, [1, 'x', null]]) {
    assert.equal(jsonByteLength(value), Buffer.byteLength(JSON.stringify(value)));
  }
});

test('AC12 inert JSON preflight rejects executable hooks without invoking them', () => {
  let invoked = 0;
  for (const value of [{ get text() { invoked += 1; return 'private sentinel'; } },
    { toJSON() { invoked += 1; return {}; } }, Object.create({ text: 'hidden' }), [undefined],
    { number: Infinity }, { number: NaN }, { big: 1n }, new Array(100)]) {
    assert.throws(() => encodeNativeMessage(value, validate));
  }
  const cyclic = {}; cyclic.child = cyclic;
  assert.throws(() => jsonByteLength(cyclic), /invalid_json/);
  assert.equal(invoked, 0);
});

test('AC13 every split of a multibyte frame and coalesced frames round-trips', async () => {
  const message = { text: 'synthetic 😀 漢字 café' };
  const frame = encodeNativeMessage(message, validate);
  for (let split = 0; split <= frame.length; split += 1) {
    const decoder = new NativeFrameDecoder(validate);
    const received = [];
    await decoder.consume(frame.subarray(0, split), (value) => received.push(value));
    await decoder.consume(frame.subarray(split), (value) => received.push(value));
    decoder.finish();
    assert.deepEqual(received, [message]);
  }
  const decoder = new NativeFrameDecoder(validate);
  const received = [];
  await decoder.consume(Buffer.concat([frame, frame, frame]), (value) => received.push(value));
  decoder.finish();
  assert.deepEqual(received, [message, message, message]);
});

test('AC13 maximum envelope preserves exact UTF-8 bytes and refuses one byte over', async () => {
  const message = { text: 'x'.repeat(MAX_MESSAGE_BYTES - Buffer.byteLength('{"text":""}')) };
  const frame = encodeNativeMessage(message, validate);
  assert.equal(frame.length, MAX_MESSAGE_BYTES + 4);
  const decoder = new NativeFrameDecoder(validate);
  let digest;
  for (let offset = 0; offset < frame.length; offset += 97) {
    await decoder.consume(frame.subarray(offset, offset + 97), (value) => {
      digest = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    });
    assert.ok(decoder.allocatedBodyBytes <= MAX_MESSAGE_BYTES);
  }
  assert.equal(digest, createHash('sha256').update(frame.subarray(4)).digest('hex'));
  decoder.finish();
  message.text += 'x';
  let validated = false;
  assert.throws(() => encodeNativeMessage(message, () => { validated = true; }), /message_too_large/);
  assert.equal(validated, false);
});

test('AC13 oversized and empty lengths reject before a body allocation or consumer effect', async () => {
  for (const length of [0, MAX_MESSAGE_BYTES + 1, 0xffffffff]) {
    const decoder = new NativeFrameDecoder(validate);
    const header = Buffer.alloc(4);
    header[endianness() === 'LE' ? 'writeUInt32LE' : 'writeUInt32BE'](length);
    let accepted = 0;
    await assert.rejects(decoder.consume(header, () => accepted++), /invalid_frame_length/);
    assert.equal(decoder.allocatedBodyBytes, 0);
    assert.equal(accepted, 0);
    await assert.rejects(decoder.consume(Buffer.alloc(0), () => {}), /decoder_closed/);
  }
});

test('AC13 malformed UTF-8/JSON, incomplete frames and excessive nesting fail closed', async () => {
  for (const body of [Buffer.from([0xc0, 0xaf]), Buffer.from('{"text":"SECRET",'),
    Buffer.from('\ufeff{"text":"x"}'), Buffer.from('['.repeat(66) + '0' + ']'.repeat(66))]) {
    const decoder = new NativeFrameDecoder(validate);
    await assert.rejects(decoder.consume(rawFrame(body), () => assert.fail('must not accept')),
      (error) => !error.message.includes('SECRET'));
  }
  for (const length of [1, 3, 4, 8]) {
    const decoder = new NativeFrameDecoder(validate);
    await decoder.consume(encodeNativeMessage({ text: 'x' }, validate).subarray(0, length), () => {});
    assert.throws(() => decoder.finish(), /truncated_frame/);
  }
});

test('AC13 consumer backpressure prevents processing the next frame; concurrent input rejects', async () => {
  const decoder = new NativeFrameDecoder(validate);
  const frame = encodeNativeMessage({ text: 'synthetic' }, validate);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let count = 0;
  const consuming = decoder.consume(Buffer.concat([frame, frame]), async () => {
    count += 1;
    if (count === 1) await gate;
  });
  assert.equal(count, 1);
  assert.equal(decoder.allocatedBodyBytes, 0);
  await assert.rejects(decoder.consume(frame, () => {}), /concurrent_consume/);
  release();
  await consuming;
  assert.equal(count, 2);
  decoder.finish();
});

test('AC02 schema rejection and consumer failure close the decoder without leaking diagnostics', async () => {
  assert.throws(() => encodeNativeMessage({ text: 'x' }, () => {
    throw new Error('SECRET');
  }), { message: 'frame_rejected' });
  for (const validator of [() => { throw new Error('SECRET'); },
    () => { throw new FrameError('SECRET'); }, validate]) {
    const decoder = new NativeFrameDecoder(validator);
    await assert.rejects(decoder.consume(encodeNativeMessage({ text: 'x' }, validate), () => {
      throw new FrameError('SECRET');
    }), { message: 'frame_rejected' });
    assert.equal(decoder.allocatedBodyBytes, 0);
  }
});

test('T01 clock and queue-only transport support offline failures without live fallback', async () => {
  const clock = new FakeClock();
  const start = clock.read();
  clock.advance(5000); clock.jumpWall(-70_000);
  assert.equal(clock.read().wall - start.wall, -65_000);
  assert.equal(clock.read().monotonic - start.monotonic, 5000);
  clock.reboot('synthetic-next-boot', 1000);
  assert.equal(clock.read().monotonic, 0);
  assert.equal(clock.read().bootId, 'synthetic-next-boot');
  const transport = new FakeTransport([{ status: 429, retry_after: '7200' }, new Error('synthetic_disconnect')]);
  assert.equal((await transport.request({ kind: 'session' })).status, 429);
  await assert.rejects(transport.request({ kind: 'body' }), /synthetic_disconnect/);
  await assert.rejects(transport.request({ kind: 'catalog' }), /synthetic_transport_exhausted/);
  await assert.rejects(transport.request({ kind: 'arbitrary' }), /unexpected_request_kind/);
  assert.equal(transport.calls.length, 2);
});
