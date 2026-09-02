import { describe, expect, it } from 'vitest'

import { parseConfigDocument } from '../../../src/config/load.js'
import { migrateConfigDocumentV1ToV2 } from '../../../src/config/migrations/index.js'
import { serializeConfig } from '../../../src/config/serialize.js'
import type { WrkrsConfig } from '../../../src/core/configuration.js'

const base: WrkrsConfig = {
  schemaVersion: 2,
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
  providers: {},
  extensions: {},
}

function v1FromCurrent(text: string): string {
  return text
    .replace('schema version 2', 'schema version 1')
    .replace('schemaVersion: 2', 'schemaVersion: 1')
    .replace(/\nexecution:\n  profile: adaptive\n/, '\n')
}

describe('comment-preserving config v1 → v2 migration', () => {
  it('110: migrates a version 1 configuration to version 2, adding execution.profile: adaptive', () => {
    const v1 = v1FromCurrent(serializeConfig(base))
    const parsedV1 = parseConfigDocument(v1)
    expect(parsedV1.ok).toBe(true)
    if (!parsedV1.ok) return
    expect(parsedV1.value.sourceSchemaVersion).toBe(1)
    expect(parsedV1.value.config.execution.profile).toBe('adaptive')

    const migrated = migrateConfigDocumentV1ToV2(v1)
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    const parsed = parseConfigDocument(migrated.value)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.sourceSchemaVersion).toBe(2)
    expect(parsed.value.migrated).toBe(false)
    expect(parsed.value.config.execution.profile).toBe('adaptive')
    expect(parsed.value.config.schemaVersion).toBe(2)
  })

  it('114: preserves owner comments, key order, blank lines, and extensions; only migrated keys differ', () => {
    const withComments = [
      '# wrkrs repository configuration (schema version 1).',
      '# owner-header-comment',
      '',
      'schemaVersion: 1',
      'preset:',
      '  id: product-engineering',
      '  version: 1',
      'runtime:',
      '  primary: claude-code',
      '# roster-comment',
      'roster:',
      '  primaryRole: product-manager',
      '  roles:',
      '    - id: product-manager',
      '      source: .wrkrs/roles/product-manager.md',
      '',
      'governance:',
      '  requirePlanApproval: true',
      '  requireDesignApproval: true',
      '  requireOwnerTestForUserFacingOrNativeWork: true',
      '  requireExplicitReleaseApproval: true',
      'providers: {}',
      'extensions:',
      '  ownerNote: keep-me',
      '',
    ].join('\n')
    const migrated = migrateConfigDocumentV1ToV2(withComments)
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    expect(migrated.value).toContain('# owner-header-comment')
    expect(migrated.value).toContain('# roster-comment')
    expect(migrated.value).toContain('ownerNote: keep-me')
    expect(migrated.value).toMatch(/schemaVersion:\s*2/)
    expect(migrated.value).toMatch(/execution:\n  profile: adaptive/)
    expect(migrated.value).not.toMatch(/schemaVersion:\s*1\b/)
    const parsed = parseConfigDocument(migrated.value)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.config.extensions).toEqual({ ownerNote: 'keep-me' })
    expect(parsed.value.config.roster.primaryRole).toBe('product-manager')
  })

  it('115: preserves an owner edit elsewhere in the file', () => {
    const edited = [
      'schemaVersion: 1',
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
      '  requirePlanApproval: false',
      '  requireDesignApproval: true',
      '  requireOwnerTestForUserFacingOrNativeWork: true',
      '  requireExplicitReleaseApproval: true',
      'providers: {}',
      'extensions: {}',
      '',
    ].join('\n')
    const migrated = migrateConfigDocumentV1ToV2(edited)
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    expect(migrated.value).toContain('requirePlanApproval: false')
    const parsed = parseConfigDocument(migrated.value)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.config.governance.requirePlanApproval).toBe(false)
  })
})
