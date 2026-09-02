import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseConfigDocument } from '../../../src/config/load.js'
import { migrateConfigDocumentV1ToV2 } from '../../../src/config/migrations/index.js'
import { REPOSITORY_ROOT } from '../../helpers/temp.js'

function fixture(name: string): string {
  return readFileSync(
    path.join(REPOSITORY_ROOT, 'test', 'fixtures', 'config-migrations', name),
    'utf8',
  )
}

describe('comment-preserving config v1 → v2 migration', () => {
  it('110: migrates a version 1 configuration to version 2, adding execution.profile: adaptive', () => {
    const v1 = fixture('config-v1.yaml')
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
    expect(parsed.value.migrated).toBe(true)
    expect(parsed.value.config.execution.profile).toBe('adaptive')
    expect(parsed.value.config.schemaVersion).toBe(3)
  })

  it('114: preserves owner comments, key order, blank lines, and extensions; only migrated keys differ', () => {
    const withComments = fixture('config-v1.yaml')
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
    const edited = fixture('config-v1-governance-edit.yaml')
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
