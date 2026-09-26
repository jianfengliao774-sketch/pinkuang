import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

// @foundry-rs/forge 1.7.1's JavaScript launcher does not propagate child exit
// codes. Validation must invoke its platform executable directly, including
// nested Forge calls made by Slither. CI's Foundry action supplies a native PATH binary.
export function forgeToolchain(root, { platform = process.platform, arch = process.arch, env = process.env } = {}) {
  const packageArch = arch === 'x64' ? 'amd64' : arch;
  const filename = platform === 'win32' ? 'forge.exe' : 'forge';
  const native = join(root, 'deploy/node_modules/@foundry-rs', `forge-${platform}-${packageArch}`, 'bin', filename);
  const windowsLegacy = join(root, '.tools/forge/package/bin/forge.exe');
  const executable = existsSync(native) ? native
    : platform === 'win32' && existsSync(windowsLegacy) ? windowsLegacy : 'forge';
  const childEnv = { ...env };
  if (executable !== 'forge') {
    // Windows treats PATH keys case-insensitively; Node otherwise passes only
    // the first spelling, potentially leaving the npm shim ahead of the binary.
    const pathKeys = Object.keys(childEnv).filter(key => platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH');
    const oldPath = pathKeys.map(key => childEnv[key]).filter(Boolean).join(delimiter);
    for (const key of pathKeys) delete childEnv[key];
    childEnv.PATH = [dirname(executable), oldPath].filter(Boolean).join(delimiter);
  }
  return { executable, env: childEnv };
}
