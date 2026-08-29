import { describe, expect, it } from 'vitest'

import { canonicalJson, hashCanonicalJson, isHash, sha256 } from '../../../src/platform/hash.js'

describe('hashing', () => {
  it('produces prefixed sha256 hashes over exact bytes', () => {
    expect(sha256('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256(new TextEncoder().encode('abc'))).toBe(sha256('abc'))
    expect(isHash(sha256('x'))).toBe(true)
    expect(isHash('sha256:nope')).toBe(false)
  })

  it('canonicalizes JSON with sorted keys and omitted undefined values', () => {
    expect(canonicalJson({ b: 1, a: [true, null, { z: 'y', y: undefined }] })).toBe(
      '{"a":[true,null,{"z":"y"}],"b":1}',
    )
    expect(hashCanonicalJson({ a: 1, b: 2 })).toBe(hashCanonicalJson({ b: 2, a: 1 }))
    expect(() => canonicalJson(new Uint8Array([1]))).toThrow(/binary/)
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/)
  })
})
