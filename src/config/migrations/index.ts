import YAML from 'yaml'

import type { WrkrsConfig, WrkrsConfigV1 } from '../../core/configuration.js'
import type { OwnershipManifest } from '../../core/ownership.js'
import { err, ok, type Result } from '../../core/result.js'

/**
 * Explicit, one-version-at-a-time schema migrations.
 *
 * Readers identify the version first, validate against that version, and
 * reject anything unsupported instead of guessing. `wrkrs check` never
 * migrates: it reports a readable older document and names the command that
 * rewrites it.
 */
export const CURRENT_CONFIG_SCHEMA_VERSION = 2
export const SUPPORTED_CONFIG_SCHEMA_VERSIONS: readonly number[] = [1, 2]

export const CURRENT_MANIFEST_SCHEMA_VERSION = 2
export const SUPPORTED_MANIFEST_SCHEMA_VERSIONS: readonly number[] = [1, 2]

export function isSupportedConfigSchemaVersion(version: number): boolean {
  return SUPPORTED_CONFIG_SCHEMA_VERSIONS.includes(version)
}

export function isSupportedManifestSchemaVersion(version: number): boolean {
  return SUPPORTED_MANIFEST_SCHEMA_VERSIONS.includes(version)
}

export interface MigrationError {
  readonly code: string
  readonly message: string
}

/**
 * Version 1 recorded only complete installations, because no command could
 * remove part of one. The migration is therefore total: state becomes
 * `installed`. Nothing else changes.
 */
export interface ManifestV1 {
  readonly schemaVersion: 1
  readonly installationId: string
  readonly wrkrsVersion: string
  readonly installedAt: string
  readonly updatedAt: string
  readonly preset: { readonly id: string; readonly version: number }
  readonly runtimeAdapters: readonly { readonly id: string; readonly version: number }[]
  readonly entries: OwnershipManifest['entries']
  readonly createdDirectories: readonly string[]
}

export function migrateManifestV1ToV2(manifest: ManifestV1): OwnershipManifest {
  const { schemaVersion: _ignored, ...rest } = manifest
  return { schemaVersion: 2, state: 'installed', ...rest }
}

/**
 * In-memory v1 → v2: add `execution.profile: adaptive`. Total and lossless.
 * Used by readers; it never writes.
 */
export function migrateConfigV1ToV2(config: WrkrsConfigV1): WrkrsConfig {
  return {
    schemaVersion: 2,
    preset: config.preset,
    runtime: config.runtime,
    roster: config.roster,
    governance: config.governance,
    execution: { profile: 'adaptive' },
    providers: config.providers,
    extensions: config.extensions,
  }
}

/**
 * Comment-preserving YAML edit for a version 1 config.yaml: bump schemaVersion
 * to 2 and insert `execution.profile: adaptive` before `providers` when
 * present. Comments, key order, blank lines, and untouched sections stay.
 */
export function migrateConfigDocumentV1ToV2(text: string): Result<string, MigrationError> {
  const document = YAML.parseDocument(text, { uniqueKeys: true, strict: true })
  if (document.errors.length > 0) {
    return err({
      code: 'CONFIG_MIGRATION_UNREADABLE',
      message: 'config.yaml could not be re-parsed for a comment-preserving migration',
    })
  }
  if (!YAML.isMap(document.contents)) {
    return err({
      code: 'CONFIG_MIGRATION_UNREADABLE',
      message: 'config.yaml must contain a mapping at the top level',
    })
  }
  const map = document.contents
  const schemaPair = map.items.find(
    (item) => YAML.isScalar(item.key) && item.key.value === 'schemaVersion',
  )
  if (schemaPair && YAML.isScalar(schemaPair.value)) {
    schemaPair.value.value = 2
  } else {
    document.set('schemaVersion', 2)
  }

  if (!map.has('execution')) {
    document.set('execution', { profile: 'adaptive' })
    if (YAML.isMap(document.contents)) {
      const items = document.contents.items
      const keys = items.map((item) => (YAML.isScalar(item.key) ? String(item.key.value) : ''))
      const executionIndex = keys.lastIndexOf('execution')
      const providersIndex = keys.indexOf('providers')
      const extensionsIndex = keys.indexOf('extensions')
      const insertAt = providersIndex >= 0 ? providersIndex : extensionsIndex
      if (executionIndex >= 0 && insertAt >= 0 && executionIndex !== insertAt) {
        const [pair] = items.splice(executionIndex, 1)
        if (pair) {
          const adjusted = executionIndex < insertAt ? insertAt - 1 : insertAt
          items.splice(adjusted, 0, pair)
        }
      }
    }
  }
  let rendered = document.toString({ lineWidth: 0 })
  if (!rendered.endsWith('\n')) rendered += '\n'
  return ok(rendered)
}
