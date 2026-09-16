import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'miyo-catchup-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

export class FakeClock {
  constructor({ wall = 1_800_000_000_000, monotonic = 0, bootId = 'synthetic-boot' } = {}) {
    this.wall = wall;
    this.monotonic = monotonic;
    this.bootId = bootId;
  }

  read = () => ({ wall: this.wall, monotonic: this.monotonic, bootId: this.bootId });
  advance(ms) { this.wall += ms; this.monotonic += ms; }
  jumpWall(ms) { this.wall += ms; }
  reboot(bootId, elapsed = 0) { this.wall += elapsed; this.monotonic = 0; this.bootId = bootId; }
}

// Queue-only transport: no URLs, sockets, global fetch, or live fallback.
export class FakeTransport {
  #outcomes;
  calls = [];

  constructor(outcomes = []) { this.#outcomes = [...outcomes]; }
  request = async (request) => {
    if (!['session', 'catalog', 'body'].includes(request.kind)) throw new Error('unexpected_request_kind');
    if (!this.#outcomes.length) throw new Error('synthetic_transport_exhausted');
    this.calls.push(structuredClone(request));
    const outcome = this.#outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return structuredClone(outcome);
  };
}
