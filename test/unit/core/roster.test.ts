import { describe, expect, it } from 'vitest'

import { recommendRoster, ROLE_IDS } from '../../../src/core/roster.js'
import type { ProjectSignal } from '../../../src/core/snapshot.js'
import { productEngineeringPreset } from '../../../src/presets/product-engineering/index.js'

const webSignals: ProjectSignal[] = [
  { id: 'web.react', path: 'package.json', detail: 'dependencies.react' },
  { id: 'typescript.tsconfig', path: 'tsconfig.json', detail: 'TypeScript config' },
  { id: 'node.package', path: 'package.json', detail: 'package manifest' },
]

describe('recommendRoster', () => {
  it('always recommends exactly the four locked roles with Product Manager primary', () => {
    for (const signals of [[], webSignals]) {
      const roster = recommendRoster(productEngineeringPreset, signals)
      expect(roster.roles.map((role) => role.id)).toEqual([...ROLE_IDS])
      expect(roster.roles.filter((role) => role.primary).map((role) => role.id)).toEqual([
        'product-manager',
      ])
      expect(roster.primaryRoleId).toBe('product-manager')
      expect(roster.presetId).toBe('product-engineering')
    }
  })

  it('attaches specializations with machine-readable evidence only to the Software Engineer', () => {
    const roster = recommendRoster(productEngineeringPreset, webSignals)
    const engineer = roster.roles.find((role) => role.id === 'software-engineer')
    expect(engineer?.specializations.map((specialization) => specialization.id)).toEqual([
      'javascript',
      'typescript',
      'web-frontend',
    ])
    for (const specialization of engineer?.specializations ?? []) {
      expect(specialization.evidence.length).toBeGreaterThan(0)
      for (const evidence of specialization.evidence) {
        expect(evidence).toEqual({
          signal: expect.any(String),
          path: expect.any(String),
          detail: expect.any(String),
        })
      }
    }
    for (const role of roster.roles.filter((candidate) => candidate.id !== 'software-engineer')) {
      expect(role.specializations).toEqual([])
    }
    expect(roster.evidence.length).toBe(
      (engineer?.specializations ?? []).reduce((sum, item) => sum + item.evidence.length, 0),
    )
  })

  it('never introduces platform-specific engineer roles and ignores unknown signals', () => {
    const roster = recommendRoster(productEngineeringPreset, [
      { id: 'apple.xcodeproj', path: 'App.xcodeproj', detail: 'Xcode project' },
      { id: 'unknown.signal', path: 'x', detail: 'y' },
    ])
    expect(roster.roles.map((role) => role.id)).toEqual([...ROLE_IDS])
    expect(
      roster.roles
        .find((role) => role.id === 'software-engineer')
        ?.specializations.map((s) => s.id),
    ).toEqual(['apple-platforms'])
  })

  it('is deterministic regardless of signal order', () => {
    const forward = recommendRoster(productEngineeringPreset, webSignals)
    const reversed = recommendRoster(productEngineeringPreset, [...webSignals].reverse())
    expect(reversed).toEqual(forward)
  })
})
