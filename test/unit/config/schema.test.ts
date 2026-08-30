import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { renderConfigJsonSchema } from '../../../src/config/json-schema.js'
import {
  parseConfigDocument,
  parseJournalDocument,
  parseManifestDocument,
} from '../../../src/config/load.js'
import { serializeConfig, serializeManifest } from '../../../src/config/serialize.js'
import type { WrkrsConfig } from '../../../src/core/configuration.js'
import type { OwnershipManifest } from '../../../src/core/ownership.js'
import { REPOSITORY_ROOT } from '../../helpers/temp.js'

const validConfig: WrkrsConfig = {
  schemaVersion: 1,
  preset: { id: 'product-engineering', version: 1 },
  runtime: { primary: 'claude-code' },
  roster: {
    primaryRole: 'product-manager',
    roles: [
      { id: 'product-manager', source: '.wrkrs/roles/product-manager.md' },
      {
        id: 'software-engineer',
        source: '.wrkrs/roles/software-engineer.md',
        specializations: ['typescript'],
      },
    ],
  },
  governance: {
    requirePlanApproval: true,
    requireDesignApproval: true,
    requireOwnerTestForUserFacingOrNativeWork: true,
    requireExplicitReleaseApproval: true,
  },
  providers: {},
  extensions: {},
}

describe('JSON schema', () => {
  it('matches the committed schema asset exactly (no silent drift)', () => {
    const committed = readFileSync(
      path.join(REPOSITORY_ROOT, 'schema', 'wrkrs-config.schema.json'),
      'utf8',
    )
    expect(renderConfigJsonSchema()).toBe(committed)
  })

  it('is strict at the root and open only for providers and extensions', () => {
    const schema = JSON.parse(renderConfigJsonSchema()) as {
      additionalProperties: boolean
      properties: Record<string, { additionalProperties?: unknown }>
    }
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties['providers']?.additionalProperties).toEqual({})
    expect(schema.properties['extensions']?.additionalProperties).toEqual({})
  })
})

describe('config loading', () => {
  it('round-trips a serialized configuration', () => {
    const text = serializeConfig(validConfig)
    expect(text.endsWith('\n')).toBe(true)
    expect(text.startsWith('# wrkrs repository configuration')).toBe(true)
    const parsed = parseConfigDocument(text)
    expect(parsed).toEqual({ ok: true, value: validConfig })
  })

  it('identifies the schema version before validating', () => {
    const missing = parseConfigDocument('preset: {}\n')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('CONFIG_SCHEMA_VERSION_MISSING')
    const unsupported = parseConfigDocument('schemaVersion: 99\n')
    expect(unsupported.ok).toBe(false)
    if (!unsupported.ok) {
      expect(unsupported.error.code).toBe('CONFIG_SCHEMA_VERSION_UNSUPPORTED')
      expect(unsupported.error.schemaVersion).toBe(99)
    }
  })

  it('rejects YAML errors, unknown fields, and inconsistent rosters', () => {
    const yamlError = parseConfigDocument('schemaVersion: [\n')
    expect(yamlError.ok).toBe(false)
    if (!yamlError.ok) expect(yamlError.error.code).toBe('CONFIG_PARSE_ERROR')

    const unknown = parseConfigDocument(serializeConfig(validConfig) + 'unexpected: true\n')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('CONFIG_INVALID')
      expect(unknown.error.issues[0]?.code).toBe('CONFIG_SCHEMA_VIOLATION')
    }

    const badPrimary = parseConfigDocument(
      serializeConfig({ ...validConfig, roster: { ...validConfig.roster, primaryRole: 'ghost' } }),
    )
    expect(badPrimary.ok).toBe(false)
    if (!badPrimary.ok)
      expect(badPrimary.error.issues.map((issue) => issue.code)).toContain(
        'CONFIG_PRIMARY_ROLE_UNKNOWN',
      )

    const duplicate = parseConfigDocument(
      serializeConfig({
        ...validConfig,
        roster: {
          primaryRole: 'product-manager',
          roles: [
            { id: 'product-manager', source: '.wrkrs/roles/a.md' },
            { id: 'product-manager', source: '.wrkrs/roles/b.md' },
          ],
        },
      }),
    )
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok)
      expect(duplicate.error.issues.map((issue) => issue.code)).toContain('CONFIG_ROLE_DUPLICATE')

    const unsafeSource = parseConfigDocument(
      serializeConfig({
        ...validConfig,
        roster: {
          primaryRole: 'product-manager',
          roles: [{ id: 'product-manager', source: 'roles/../x.md' }],
        },
      }),
    )
    expect(unsafeSource.ok).toBe(false)
  })
})

describe('manifest loading', () => {
  const manifest: OwnershipManifest = {
    schemaVersion: 1,
    installationId: '00000000-0000-4000-8000-000000000001',
    wrkrsVersion: '0.1.0',
    installedAt: '2026-08-29T12:00:00.000Z',
    updatedAt: '2026-08-29T12:00:00.000Z',
    preset: { id: 'product-engineering', version: 1 },
    runtimeAdapters: [{ id: 'claude-code', version: 1 }],
    entries: [
      {
        path: '.wrkrs/config.yaml',
        kind: 'file',
        management: 'seeded',
        sourceId: 'wrkrs/config',
        sourceVersion: 1,
        lastAppliedHash: 'sha256:' + 'a'.repeat(64),
      },
    ],
    createdDirectories: ['.wrkrs'],
  }

  it('round-trips a serialized manifest', () => {
    const text = serializeManifest(manifest)
    expect(text.endsWith('}\n')).toBe(true)
    expect(parseManifestDocument(text)).toEqual({ ok: true, value: manifest })
  })

  it('rejects unsafe or duplicate entry paths and unsupported versions', () => {
    const escaped = parseManifestDocument(
      serializeManifest({
        ...manifest,
        entries: [{ ...manifest.entries[0]!, path: '../escape.md' }],
      }),
    )
    expect(escaped.ok).toBe(false)
    if (!escaped.ok) expect(escaped.error.code).toBe('MANIFEST_INVALID')

    const unnormalized = parseManifestDocument(
      serializeManifest({
        ...manifest,
        entries: [{ ...manifest.entries[0]!, path: '.wrkrs//config.yaml' }],
      }),
    )
    expect(unnormalized.ok).toBe(false)
    if (!unnormalized.ok)
      expect(unnormalized.error.issues.some((issue) => issue.code === 'MANIFEST_PATH_UNSAFE')).toBe(
        true,
      )

    const absolute = parseManifestDocument(
      serializeManifest({
        ...manifest,
        entries: [{ ...manifest.entries[0]!, path: '/etc/passwd' }],
      }),
    )
    expect(absolute.ok).toBe(false)

    const duplicate = parseManifestDocument(
      serializeManifest({ ...manifest, entries: [manifest.entries[0]!, manifest.entries[0]!] }),
    )
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok)
      expect(duplicate.error.issues.some((issue) => issue.code === 'MANIFEST_PATH_DUPLICATE')).toBe(
        true,
      )

    const unsupported = parseManifestDocument(JSON.stringify({ ...manifest, schemaVersion: 2 }))
    expect(unsupported.ok).toBe(false)
    if (!unsupported.ok) expect(unsupported.error.code).toBe('MANIFEST_SCHEMA_VERSION_UNSUPPORTED')

    expect(parseManifestDocument('{not json').ok).toBe(false)
    expect(parseManifestDocument('[]').ok).toBe(false)
  })

  it('parses and rejects journals', () => {
    expect(parseJournalDocument('{}').ok).toBe(false)
    const journal = parseJournalDocument(
      JSON.stringify({
        schemaVersion: 1,
        transactionId: '00000000-0000-4000-8000-000000000002',
        command: 'init',
        planDigest: 'sha256:' + 'b'.repeat(64),
        startedAt: '2026-08-29T12:00:00.000Z',
        updatedAt: '2026-08-29T12:00:00.000Z',
        status: 'applying',
        durability: 'strict',
        operations: [],
        failure: null,
      }),
    )
    expect(journal.ok).toBe(true)
  })
})
