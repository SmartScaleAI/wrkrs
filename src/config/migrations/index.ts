import type { OwnershipManifest } from '../../core/ownership.js'

/**
 * Explicit, one-version-at-a-time schema migrations.
 *
 * Readers identify the version first, validate against that version, and
 * reject anything unsupported instead of guessing. `wrkrs check` never
 * migrates: it reports a readable older document and names the command that
 * rewrites it.
 */
export const CURRENT_CONFIG_SCHEMA_VERSION = 1
export const SUPPORTED_CONFIG_SCHEMA_VERSIONS: readonly number[] = [1]

export const CURRENT_MANIFEST_SCHEMA_VERSION = 2
export const SUPPORTED_MANIFEST_SCHEMA_VERSIONS: readonly number[] = [1, 2]

export function isSupportedConfigSchemaVersion(version: number): boolean {
  return SUPPORTED_CONFIG_SCHEMA_VERSIONS.includes(version)
}

export function isSupportedManifestSchemaVersion(version: number): boolean {
  return SUPPORTED_MANIFEST_SCHEMA_VERSIONS.includes(version)
}

/** Version 1 manifest as it was written before the installation state existed. */
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

/**
 * Version 1 recorded only complete installations, because no command could
 * remove part of one. The migration is therefore total: state becomes
 * `installed`. Nothing else changes.
 */
export function migrateManifestV1ToV2(manifest: ManifestV1): OwnershipManifest {
  const { schemaVersion: _ignored, ...rest } = manifest
  return { schemaVersion: 2, state: 'installed', ...rest }
}
