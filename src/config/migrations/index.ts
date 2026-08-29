/**
 * Explicit, one-version-at-a-time schema migrations.
 *
 * Version 1 is the first durable format, so no migration exists yet. Readers
 * identify the version first, validate against that version, and reject
 * anything unsupported instead of guessing. `wrkrs check` never migrates.
 */
export const CURRENT_CONFIG_SCHEMA_VERSION = 1
export const SUPPORTED_CONFIG_SCHEMA_VERSIONS: readonly number[] = [1]

export const CURRENT_MANIFEST_SCHEMA_VERSION = 1
export const SUPPORTED_MANIFEST_SCHEMA_VERSIONS: readonly number[] = [1]

export function isSupportedConfigSchemaVersion(version: number): boolean {
  return SUPPORTED_CONFIG_SCHEMA_VERSIONS.includes(version)
}

export function isSupportedManifestSchemaVersion(version: number): boolean {
  return SUPPORTED_MANIFEST_SCHEMA_VERSIONS.includes(version)
}
