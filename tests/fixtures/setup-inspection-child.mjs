import { runSetupInspectionOwner } from '../../src/setup-inspection-entry.mjs';

const [trustedBoundary, configPath, mode] = process.argv.slice(2);
if (typeof trustedBoundary !== 'string' || typeof configPath !== 'string') {
  process.exitCode = 2;
} else {
  try {
    await runSetupInspectionOwner({
      trustedBoundary,
      configPath,
      lifetimeMs: 10 * 60 * 1000,
      ...(mode === 'delayed-close' ? {
        createServer: async (options) => {
          const server = await (await import('../../src/probe-socket.mjs')).createProbeSocketServer(options);
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
