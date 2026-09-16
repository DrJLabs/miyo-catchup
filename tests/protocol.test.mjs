import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assertRequest, MAX_RAW_CHUNK_BYTES } from '../src/contracts.mjs';
import { encodeNativeMessage, NativeFrameDecoder } from '../src/framing.mjs';

const id = '11111111-1111-4111-8111-111111111111';

test('AC02 protocol validation is enforced after framing and before consumer effects', async () => {
  const message = { protocol_version: 2, request_id: id, operation: 'get_status', payload: {} };
  // Simulate bytes from an untrusted peer, which does not run our validator.
  const frame = encodeNativeMessage(message, () => {});
  const decoder = new NativeFrameDecoder(assertRequest);
  let accepted = 0;
  await assert.rejects(decoder.consume(frame, () => { accepted += 1; }), /frame_rejected/);
  assert.equal(accepted, 0);
  assert.equal(decoder.allocatedBodyBytes, 0);
});

test('AC13 maximum raw chunk round-trips through the actual wire validator with exact digest', async () => {
  const bytes = Buffer.from('😀'.repeat(MAX_RAW_CHUNK_BYTES / 4));
  const request = {
    protocol_version: 1, request_id: id, operation: 'result_chunk',
    run_id: id, attempt_id: id, lease_generation: 1, permit_id: id,
    payload: { sequence: 0, decoded_bytes: bytes.length, data: bytes.toString('base64') },
  };
  const frame = encodeNativeMessage(request, assertRequest);
  const decoder = new NativeFrameDecoder(assertRequest);
  let received;
  for (let offset = 0; offset < frame.length; offset += 4093) {
    await decoder.consume(frame.subarray(offset, offset + 4093), (message) => {
      received = Buffer.from(message.payload.data, 'base64');
    });
  }
  decoder.finish();
  assert.deepEqual(received, bytes);
  const digest = (data) => createHash('sha256').update(data).digest('hex');
  assert.equal(digest(received), digest(bytes));
  const oversized = Buffer.concat([bytes, Buffer.from('x')]);
  request.payload = { sequence: 0, decoded_bytes: oversized.length, data: oversized.toString('base64') };
  assert.throws(() => encodeNativeMessage(request, assertRequest), /frame_rejected/);
});
