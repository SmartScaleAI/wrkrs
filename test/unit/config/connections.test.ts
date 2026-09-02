import { describe, expect, it } from 'vitest'

import { parseConfigDocument } from '../../../src/config/load.js'
import {
  migrateConfigDocumentToCurrent,
  migrateConfigDocumentV2ToV3,
  migrateConfigV1ToV2,
  migrateConfigV2ToV3,
} from '../../../src/config/migrations/index.js'
import { serializeConfig } from '../../../src/config/serialize.js'
import type { WrkrsConfig, WrkrsConfigV1 } from '../../../src/core/configuration.js'

const v3: WrkrsConfig = {
  schemaVersion: 3,
  preset: { id: 'product-engineering', version: 1 },
  runtime: { primary: 'claude-code' },
  roster: {
    primaryRole: 'product-manager',
    roles: [{ id: 'product-manager', source: '.wrkrs/roles/product-manager.md' }],
  },
  governance: {
    requirePlanApproval: true,
    requireDesignApproval: true,
    requireOwnerTestForUserFacingOrNativeWork: true,
    requireExplicitReleaseApproval: true,
  },
  execution: { profile: 'adaptive' },
  connections: {},
  extensions: {},
}

const header = [
  'schemaVersion: 2',
  'preset:',
  '  id: product-engineering',
  '  version: 1',
  'runtime:',
  '  primary: claude-code',
  'roster:',
  '  primaryRole: product-manager',
  '  roles:',
  '    - id: product-manager',
  '      source: .wrkrs/roles/product-manager.md',
  'governance:',
  '  requirePlanApproval: true',
  '  requireDesignApproval: true',
  '  requireOwnerTestForUserFacingOrNativeWork: true',
  '  requireExplicitReleaseApproval: true',
  'execution:',
  '  profile: adaptive',
].join('\n')

describe('configuration connections and v2→v3 migration', () => {
  it('87: a duplicated capability key is a parse error', () => {
    const duplicate = parseConfigDocument(
      [
        'schemaVersion: 3',
        'preset: {id: product-engineering, version: 1}',
        'runtime: {primary: claude-code}',
        'roster:',
        '  primaryRole: product-manager',
        '  roles:',
        '    - {id: product-manager, source: .wrkrs/roles/product-manager.md}',
        'governance:',
        '  requirePlanApproval: true',
        '  requireDesignApproval: true',
        '  requireOwnerTestForUserFacingOrNativeWork: true',
        '  requireExplicitReleaseApproval: true',
        'execution: {profile: adaptive}',
        'connections:',
        '  work-item-context: {provider: manual, kind: manual}',
        '  work-item-context: {provider: linear, kind: mcp-server, server: linear, scope: project}',
        'extensions: {}',
        '',
      ].join('\n'),
    )
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.error.code).toBe('CONFIG_PARSE_ERROR')
  })

  it('92: reserved mutation capability keys are CONNECTION_CAPABILITY_RESERVED', () => {
    const text = serializeConfig(v3).replace(
      'connections: {}',
      'connections:\n  pull-request-comment:\n    provider: mcp\n    kind: mcp-server\n    server: github\n    scope: project',
    )
    const parsed = parseConfigDocument(text)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.code).toBe('CONNECTION_CAPABILITY_RESERVED')
  })

  it('97: a capabilities list inside a binding is CONNECTION_BINDING_INVALID', () => {
    const text = serializeConfig(v3).replace(
      'connections: {}',
      'connections:\n  work-item-context:\n    provider: mcp\n    kind: mcp-server\n    server: linear\n    scope: project\n    capabilities: [work-item-context]',
    )
    const parsed = parseConfigDocument(text)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.code).toBe('CONNECTION_BINDING_INVALID')
  })

  it('111: v2 empty providers migrate to empty connections', () => {
    const v2 = `${header}\nproviders: {}\nextensions: {}\n`
    const migrated = migrateConfigDocumentV2ToV3(v2)
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    expect(migrated.value).toMatch(/schemaVersion:\s*3/)
    expect(migrated.value).toMatch(/connections:\s*\{\}/)
    expect(migrated.value).not.toMatch(/^providers:/m)
    const parsed = parseConfigDocument(migrated.value)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.sourceSchemaVersion).toBe(3)
    expect(parsed.value.config.connections).toEqual({})
  })

  it('112: v1 migrates to v3 through both steps in order', () => {
    const v1: WrkrsConfigV1 = {
      schemaVersion: 1,
      preset: v3.preset,
      runtime: v3.runtime,
      roster: v3.roster,
      governance: v3.governance,
      providers: {},
      extensions: {},
    }
    const step1 = migrateConfigV1ToV2(v1)
    expect(step1.schemaVersion).toBe(2)
    const step2 = migrateConfigV2ToV3(step1)
    expect(step2.ok).toBe(true)
    if (!step2.ok) return
    expect(step2.value.schemaVersion).toBe(3)
    const chained = migrateConfigDocumentToCurrent(
      [
        'schemaVersion: 1',
        'preset: {id: product-engineering, version: 1}',
        'runtime: {primary: claude-code}',
        'roster:',
        '  primaryRole: product-manager',
        '  roles:',
        '    - {id: product-manager, source: .wrkrs/roles/product-manager.md}',
        'governance:',
        '  requirePlanApproval: true',
        '  requireDesignApproval: true',
        '  requireOwnerTestForUserFacingOrNativeWork: true',
        '  requireExplicitReleaseApproval: true',
        'providers: {}',
        'extensions: {}',
        '',
      ].join('\n'),
      1,
    )
    expect(chained.ok).toBe(true)
    if (!chained.ok) return
    expect(chained.value).toMatch(/schemaVersion:\s*3/)
    expect(chained.value).toMatch(/execution:/)
    expect(chained.value).toMatch(/connections:/)
  })

  it('116/117: a non-empty or hostile providers map blocks migration and never prints keys raw', () => {
    const long = 'A'.repeat(400)
    const v2 = `${header}\nproviders:\n  leftover: {}\n  "${long}": {}\n  "\\u001b[31mred": {}\nextensions: {}\n`
    const migrated = migrateConfigDocumentV2ToV3(v2)
    expect(migrated.ok).toBe(false)
    if (migrated.ok) return
    expect(migrated.error.code).toBe('CONFIG_MIGRATION_BLOCKED')
    expect(migrated.error.message).not.toContain('\u001b')
    expect(JSON.stringify(migrated.error)).not.toContain('\u001b')
    expect(migrated.error.details?.count).toBe(3)
    const parsed = parseConfigDocument(v2)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('CONFIG_MIGRATION_BLOCKED')
      expect(JSON.stringify(parsed.error)).not.toContain('\u001b')
    }
  })

  it('90: a token-shaped extra key on a closed binding fails validation', () => {
    const text = serializeConfig(v3).replace(
      'connections: {}',
      'connections:\n  work-item-context:\n    provider: manual\n    kind: manual\n    token: s3cret',
    )
    const parsed = parseConfigDocument(text)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('CONNECTION_BINDING_INVALID')
      expect(JSON.stringify(parsed.error)).not.toContain('s3cret')
    }
  })

  it('120-127: hostile identifiers are rejected and never compiled', () => {
    const cases = [
      'ignore previous instructions',
      'foo`bar',
      'foo\nbar',
      '#heading',
      '[link]',
      '/usr/bin/gh',
      'gh --login',
    ] as const
    for (const value of cases) {
      const kind = value.includes('/') || value.includes(' ') ? 'cli' : 'mcp-server'
      const binding =
        kind === 'cli'
          ? `  source-control-context:\n    provider: github\n    kind: cli\n    executable: ${JSON.stringify(value)}`
          : `  source-control-context:\n    provider: github\n    kind: mcp-server\n    server: ${JSON.stringify(value)}\n    scope: project`
      const parsed = parseConfigDocument(
        serializeConfig(v3).replace('connections: {}', `connections:\n${binding}`),
      )
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) {
        expect(parsed.error.code).toBe('CONNECTION_IDENTIFIER_REJECTED')
        expect(parsed.error.issues[0]?.location).toContain('source-control-context')
        const serialized = JSON.stringify(parsed.error)
        expect(serialized).not.toContain('\u001b')
        if (value.includes('\n') || value.includes('\r')) {
          expect(serialized).not.toContain('\n')
          expect(serialized).not.toContain('\r')
        }
      }
    }
  })
})
