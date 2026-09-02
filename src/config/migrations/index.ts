import YAML from 'yaml'

import type { WrkrsConfig, WrkrsConfigV1, WrkrsConfigV2 } from '../../core/configuration.js'
import type { OwnershipManifest } from '../../core/ownership.js'
import { err, ok, type Result } from '../../core/result.js'
import { renderUntrustedList } from '../../core/sanitize.js'

/**
 * Explicit, one-version-at-a-time schema migrations.
 *
 * Readers identify the version first, validate against that version, and
 * reject anything unsupported instead of guessing. `wrkrs check` never
 * migrates: it reports a readable older document and names the command that
 * rewrites it.
 */
export const CURRENT_CONFIG_SCHEMA_VERSION = 3
export const SUPPORTED_CONFIG_SCHEMA_VERSIONS: readonly number[] = [1, 2, 3]

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
  readonly details?: Readonly<Record<string, string | number>>
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
export function migrateConfigV1ToV2(config: WrkrsConfigV1): WrkrsConfigV2 {
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
 * In-memory v2 → v3: rename empty `providers` to empty `connections`.
 * A non-empty providers map cannot be migrated.
 */
export function migrateConfigV2ToV3(config: WrkrsConfigV2): Result<WrkrsConfig, MigrationError> {
  const keys = Object.keys(config.providers)
  if (keys.length > 0) {
    return err({
      code: 'CONFIG_MIGRATION_BLOCKED',
      message: `config.yaml providers map is not empty (${keys.length} key(s)); nothing was rewritten into connections`,
      details: { keys: renderUntrustedList(keys), count: keys.length },
    })
  }
  return ok({
    schemaVersion: 3,
    preset: config.preset,
    runtime: config.runtime,
    roster: config.roster,
    governance: config.governance,
    execution: config.execution,
    connections: {},
    extensions: config.extensions,
  })
}

export function migrateConfigToCurrent(
  version: 1 | 2,
  config: WrkrsConfigV1 | WrkrsConfigV2,
): Result<WrkrsConfig, MigrationError> {
  const v2 =
    version === 1 ? migrateConfigV1ToV2(config as WrkrsConfigV1) : (config as WrkrsConfigV2)
  return migrateConfigV2ToV3(v2)
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

function bumpSchemaVersion(map: YAML.YAMLMap, document: YAML.Document, version: number): void {
  const schemaPair = map.items.find(
    (item) => YAML.isScalar(item.key) && item.key.value === 'schemaVersion',
  )
  if (schemaPair && YAML.isScalar(schemaPair.value)) {
    schemaPair.value.value = version
  } else {
    document.set('schemaVersion', version)
  }
}

function mapKeys(node: YAML.YAMLMap): string[] {
  return node.items.map((item) =>
    YAML.isScalar(item.key) ? String(item.key.value ?? '') : renderUntrustedList(['<non-scalar>']),
  )
}

/**
 * Comment-preserving YAML edit for a version 2 config.yaml: bump schemaVersion
 * to 3 and rename empty `providers` to `connections`. A non-empty providers
 * map blocks; every key is accounted for with a sanitized rendering.
 */
export function migrateConfigDocumentV2ToV3(text: string): Result<string, MigrationError> {
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
  const providersNode = map.get('providers', true)
  if (YAML.isMap(providersNode) && providersNode.items.length > 0) {
    const keys = mapKeys(providersNode)
    return err({
      code: 'CONFIG_MIGRATION_BLOCKED',
      message: `config.yaml providers map is not empty (${keys.length} key(s)); nothing was rewritten into connections`,
      details: { keys: renderUntrustedList(keys), count: keys.length },
    })
  }

  bumpSchemaVersion(map, document, 3)

  const providersPair = map.items.find(
    (item) => YAML.isScalar(item.key) && item.key.value === 'providers',
  )
  if (providersPair && YAML.isScalar(providersPair.key)) {
    providersPair.key.value = 'connections'
    if (!YAML.isMap(providersPair.value) && providersPair.value == null) {
      document.set('connections', {})
    }
  } else if (!map.has('connections')) {
    document.set('connections', {})
    if (YAML.isMap(document.contents)) {
      const items = document.contents.items
      const keys = items.map((item) => (YAML.isScalar(item.key) ? String(item.key.value) : ''))
      const connectionsIndex = keys.lastIndexOf('connections')
      const extensionsIndex = keys.indexOf('extensions')
      if (connectionsIndex >= 0 && extensionsIndex >= 0 && connectionsIndex !== extensionsIndex) {
        const [pair] = items.splice(connectionsIndex, 1)
        if (pair) {
          const adjusted =
            connectionsIndex < extensionsIndex ? extensionsIndex - 1 : extensionsIndex
          items.splice(adjusted, 0, pair)
        }
      }
    }
  }

  let rendered = document.toString({ lineWidth: 0 })
  if (!rendered.endsWith('\n')) rendered += '\n'
  return ok(rendered)
}

export function migrateConfigDocumentToCurrent(
  text: string,
  sourceVersion: number,
): Result<string, MigrationError> {
  let current = text
  if (sourceVersion === 1) {
    const toV2 = migrateConfigDocumentV1ToV2(current)
    if (!toV2.ok) return toV2
    current = toV2.value
    sourceVersion = 2
  }
  if (sourceVersion === 2) {
    return migrateConfigDocumentV2ToV3(current)
  }
  return ok(current)
}
