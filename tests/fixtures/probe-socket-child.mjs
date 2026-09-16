// Synthetic process fixture only. The parent launches this under spawnOwnedProcess
// (OS flock -n -F); no production configuration, endpoints or path defaults exist.
import { join } from 'node:path';
import { createProbeSocketServer } from '../../src/probe-socket.mjs';
import { createProbeReceiver } from '../../src/probe-receiver.mjs';
import { ensurePrivateDirectory } from '../../src/safe-paths.mjs';

const [root] = process.argv.slice(2);
if (!root || !process.send) throw new Error('synthetic_parent_required');
const stateRoot = join(root, 'state');
ensurePrivateDirectory(stateRoot, { trustedBoundary: root });
let owned = true; // Parent-held launch contract, not a general lock detector.
const receiver = createProbeReceiver({ root: stateRoot, trustedBoundary: root,
  ownership: () => owned,
  binding: { binding_id: 'synthetic-binding', principal_id: 'synthetic-principal',
    context_id: 'synthetic-personal', account_id: 'synthetic-account' },
  conversationId: 'synthetic-conversation',
  validateBody: (body, id) => body?.conversation?.id === id });
const server = await createProbeSocketServer({ socketPath: join(root, 'probe.sock'),
  privateRoot: root, trustedBoundary: root, ownership: () => owned, receiver });
process.once('message', async (message) => {
  if (message !== 'stop') return;
  await server.close();
  receiver.close();
  owned = false;
  process.disconnect();
});
process.send('ready');
