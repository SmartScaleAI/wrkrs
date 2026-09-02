import { describe, expect, it } from 'vitest'

import { recommendRoster } from '../../../src/core/roster.js'
import {
  compilePortableRoles,
  productEngineeringPreset,
} from '../../../src/presets/product-engineering/index.js'

const HIGH_RISK_TRIGGERS = [
  'new user-facing workflows',
  'authentication',
  'authorization',
  'permissions',
  'security',
  'billing',
  'production data migrations',
  'major architecture change',
  'new production dependencies',
  'multiple external systems',
  'difficult rollback',
  'broad regression risk',
] as const

const CANONICAL_STAGES = [
  'triage',
  'planning',
  'product design',
  'technical design',
  'engineering',
  'verification',
  'qa',
  'reporting',
] as const

const roster = recommendRoster(productEngineeringPreset, [])
const roles = compilePortableRoles(roster, { profile: 'adaptive' })
const manager = roles.find((role) => role.id === 'product-manager')!.content
const designer = roles.find((role) => role.id === 'product-designer')!.content
const engineer = roles.find((role) => role.id === 'software-engineer')!.content
const qa = roles.find((role) => role.id === 'qa-engineer')!.content

function section(content: string, heading: string): string {
  const start = content.indexOf(`## ${heading}`)
  expect(start).toBeGreaterThan(-1)
  const rest = content.slice(start + 3)
  const next = rest.search(/\n## /)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('adaptive execution role content (3A)', () => {
  it('74: triage evaluates work size, risk, and ambiguity independently; severity and priority are not proxies', () => {
    expect(manager).toMatch(/work size/i)
    expect(manager).toMatch(/\brisk\b/i)
    expect(manager).toMatch(/ambiguity/i)
    expect(manager).toMatch(/independently/)
    expect(manager).toMatch(/severity and ticket priority are not proxies for complexity/i)
  })

  it('75: Fast, Standard, and Full each carry explicit selection rules', () => {
    const profiles = section(manager, 'Execution profiles')
    expect(profiles).toMatch(/\*\*Fast\*\*/)
    expect(profiles).toMatch(/\*\*Standard\*\*/)
    expect(profiles).toMatch(/\*\*Full\*\*/)
    expect(profiles).toMatch(/localized and reversible/)
    expect(profiles).toMatch(/moderate multi-file/)
    expect(profiles).toMatch(/major ambiguity or any high-risk trigger/)
  })

  it('76: every high-risk trigger is mandatory and excluded from Fast', () => {
    const escalation = section(manager, 'Mandatory high-risk escalation')
    const fast = section(manager, 'Execution profiles')
    const fastBlock = fast.slice(fast.indexOf('**Fast**'), fast.indexOf('**Standard**'))
    for (const trigger of HIGH_RISK_TRIGGERS) {
      expect(escalation.toLowerCase()).toContain(trigger)
    }
    expect(fastBlock).toMatch(/excludes every high-risk trigger/)
    expect(fastBlock).toMatch(/migration/)
    expect(fastBlock).toMatch(/production dependencies/)
    expect(fastBlock).toMatch(/permissions/)
    expect(fastBlock).toMatch(/authentication/)
    expect(fastBlock).toMatch(/security/)
    expect(fastBlock).toMatch(/billing/)
    expect(fastBlock).toMatch(/external integration/)
  })

  it('77: Designer and QA participation is per-profile, not automatic', () => {
    expect(designer).toMatch(/Participation is per-profile, not automatic/)
    expect(qa).toMatch(/Participation is per-profile, not automatic/)
    expect(manager).toMatch(/Participation is per-profile, not automatic/)
  })

  it('78: technical design routes to a Software Engineer specialization; no new permanent role', () => {
    expect(engineer).toMatch(/Technical design/)
    expect(engineer).toMatch(/No permanent architect, frontend, backend, or data-science role/)
    expect(productEngineeringPreset.roles.map((role) => role.id)).toEqual([
      'product-manager',
      'product-designer',
      'software-engineer',
      'qa-engineer',
    ])
    for (const role of roles) {
      expect(role.content).not.toMatch(/^id: (architect|frontend|backend|data-science)$/m)
    }
  })

  it('79: Fast output block is present and bounded to the routing report', () => {
    const routing = section(manager, 'Routing report')
    expect(routing).toContain('Execution profile: Fast')
    expect(routing).toContain('Planning: minimal')
    expect(routing).toContain('Product design: none')
    expect(routing).toContain('Technical design: none')
    expect(routing).toContain('Engineering: one worker')
    expect(routing).toContain('Verification: targeted')
    expect(routing).toContain('It is the routing report, not a timing record.')
  })

  it('80: every profile requires verification evidence and a final acceptance check', () => {
    const floor = section(manager, 'Quality floor')
    expect(floor).toMatch(/Every profile, including Fast/)
    expect(floor).toMatch(/verification evidence proportional to risk/)
    expect(floor).toMatch(/final acceptance check against the criteria/)
  })

  it('81: owner may raise rigor; a speed request cannot bypass a mandatory gate', () => {
    expect(manager).toMatch(/owner may request a faster or more thorough workflow/i)
    expect(manager).toMatch(/never bypasses a mandatory gate/)
  })

  it('82: unrelated refactoring, speculative improvement, unnecessary research, and unrequested documentation are prohibited', () => {
    for (const content of [manager, designer, engineer, qa]) {
      expect(content).toMatch(/unrelated refactoring/)
      expect(content).toMatch(/speculative improvement/)
      expect(content).toMatch(/unnecessary research/)
      expect(content).toMatch(/unrequested documentation/)
    }
  })

  it('84: no generated content claims measured timing; stage reports are self-reported', () => {
    for (const role of roles) {
      expect(role.content).not.toMatch(
        /\b\d+\s*(ms|sec|secs|second|seconds|minute|minutes|hour|hours)\b/i,
      )
      expect(role.content).not.toMatch(/\b37\b/)
    }
    expect(manager).toMatch(/self-reported by the Product Manager/)
    expect(manager).toContain('Elapsed time: not measured by wrkrs')
  })

  it('106-109: stage log uses the canonical vocabulary; retries is a metric', () => {
    const log = section(manager, 'Stage log')
    expect(log).toContain('Stage log (self-reported by the Product Manager; not measured)')
    for (const stage of CANONICAL_STAGES) {
      const matches = [...log.matchAll(new RegExp(`^\\s+${stage}:`, 'gim'))]
      expect(matches, stage).toHaveLength(1)
    }
    expect(log).not.toMatch(/^\s+retries:/m)
    expect(log).toMatch(/^ {4}Retries: 0$/m)
    expect(log).toContain('Elapsed time: not measured by wrkrs')
    expect(log).toMatch(/skipped - /)
    expect(log).toMatch(/run/)
  })
})
