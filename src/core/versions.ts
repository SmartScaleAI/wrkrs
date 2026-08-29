/** Product-level version constants and a tiny semver comparison for environment checks. */
export const MINIMUM_NODE_VERSION = '22.12.0'

export interface SemanticVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

export function parseSemanticVersion(input: string): SemanticVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(input.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function compareSemanticVersions(a: SemanticVersion, b: SemanticVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

export function satisfiesMinimumVersion(version: string, minimum: string): boolean {
  const parsed = parseSemanticVersion(version)
  const floor = parseSemanticVersion(minimum)
  if (!parsed || !floor) return false
  return compareSemanticVersions(parsed, floor) >= 0
}
