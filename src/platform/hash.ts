import { createHash } from 'node:crypto'

export const HASH_PREFIX = 'sha256:'

export function sha256(data: Uint8Array | string): string {
  return HASH_PREFIX + createHash('sha256').update(data).digest('hex')
}

export function isHash(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value)
}

/**
 * Canonical JSON: sorted object keys, no whitespace, undefined values omitted.
 * Used for plan digests so semantically equal plans hash identically.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize a non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    return (
      '[' + value.map((item) => canonicalJson(item === undefined ? null : item)).join(',') + ']'
    )
  }
  if (value instanceof Uint8Array) {
    throw new TypeError('Cannot canonicalize binary data')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    return (
      '{' +
      keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') +
      '}'
    )
  }
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`)
}

export function hashCanonicalJson(value: unknown): string {
  return sha256(canonicalJson(value))
}
