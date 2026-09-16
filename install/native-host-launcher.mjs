import { normalizeAbsolutePath } from '../src/safe-paths.mjs';

function quotePath(value) {
  if (typeof value !== 'string' || value === '/' || value.length > 4096
    || /[^\x20-\x7e]/.test(value)) throw new Error('invalid_launcher_path');
  normalizeAbsolutePath(value);
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Render only. Does not install, register, chmod, spawn or overwrite files. */
export function nativeHostLauncher({ nodePath, entryPath, configurationPath } = {}) {
  // Absolute version-qualified binary and release paths must be checked by the
  // operator at pairing time. Never use PATH, env expansion or an eval command.
  return `#!/bin/sh\nexec ${quotePath(nodePath)} ${quotePath(entryPath)} ${quotePath(configurationPath)} "$@"\n`;
}
