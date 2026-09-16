import { runConnectionCheckOwner } from '../../src/connection-check-entry.mjs';
import { createProbeSocketServer } from '../../src/probe-socket.mjs';

const [trustedBoundary, configPath, mode] = process.argv.slice(2);
if (typeof trustedBoundary !== 'string' || typeof configPath !== 'string') {
  process.exitCode = 2;
} else {
  try {
    await runConnectionCheckOwner({
      trustedBoundary,
      configPath,
      lifetimeMs: 10 * 60 * 1000,
      ...(mode === 'delayed-close' ? {
        createServer: async (options) => {
          const server = await createProbeSocketServer(options);
          return {
            async close() {
              process.stdout.write('closing\n');
              await new Promise((resolve) => setTimeout(resolve, 150));
              await server.close();
            },
          };
        },
      } : {}),
    });
  } catch {
    process.exitCode = 1;
  }
}
