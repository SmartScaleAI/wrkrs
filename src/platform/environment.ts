import * as nodePath from 'node:path'

import type { EnvironmentPort, FileSystemPort } from '../core/ports.js'
import { isBareExecutableName } from '../core/sanitize.js'

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
  if (!isBareExecutableName(name)) return null
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

/** PATH-looks-up each bare executable name without running anything. */
export async function findPresentExecutables(
  names: Iterable<string>,
  environment: EnvironmentPort,
  fs: FileSystemPort,
): Promise<ReadonlySet<string>> {
  const present = new Set<string>()
  for (const name of names) {
    if ((await findExecutable(name, environment, fs)) !== null) present.add(name)
  }
  return present
}
