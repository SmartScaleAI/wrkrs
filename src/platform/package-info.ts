import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface PackageInfo {
  readonly name: string
  readonly version: string
}

/** Reads the published package metadata relative to this module (works from src and dist). */
export function readPackageInfo(): PackageInfo {
  const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url))
  const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { name: string; version: string }
  return { name: parsed.name, version: parsed.version }
}
