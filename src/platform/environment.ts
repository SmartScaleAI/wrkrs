import * as nodePath from 'node:path'

import type { EnvironmentPort, FileSystemPort } from '../core/ports.js'

export function createNodeEnvironment(): EnvironmentPort {
  const isWindows = process.platform === 'win32'
  const pathExtensions = isWindows
    ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((ext) => ext.length > 0)
    : ['']
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    executablePaths: (process.env['PATH'] ?? '')
      .split(nodePath.delimiter)
      .filter((entry) => entry.length > 0),
    pathExtensions,
    processId: process.pid,
  }
}

/** Finds an executable on PATH without running it. */
export async function findExecutable(
  name: string,
  environment: EnvironmentPort,
  fs: FileSystemPort,
): Promise<string | null> {
  for (const directory of environment.executablePaths) {
    for (const extension of environment.pathExtensions) {
      const candidate = nodePath.join(directory, name + extension)
      const stat = await fs.lstat(candidate)
      if (stat && (stat.kind === 'file' || stat.kind === 'symlink')) {
        return candidate
      }
    }
  }
  return null
}
