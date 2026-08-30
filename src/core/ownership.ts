/**
 * Ownership manifest contract and well-known repository paths.
 */
export const MANIFEST_SCHEMA_VERSION = 1

export const WRKRS_DIRECTORY = '.wrkrs'
export const CONFIG_PATH = '.wrkrs/config.yaml'
export const SCHEMA_PATH = '.wrkrs/schema.json'
export const MANIFEST_PATH = '.wrkrs/manifest.json'
export const ROLES_DIRECTORY = '.wrkrs/roles'
export const LOCK_PATH = '.wrkrs/.lock'
export const JOURNAL_PATH = '.wrkrs/.journal.json'

export const MANAGEMENT_MODES = ['managed', 'seeded', 'patched', 'referenced'] as const
export type ManagementMode = (typeof MANAGEMENT_MODES)[number]

export interface ManifestEntry {
  readonly path: string
  readonly kind: 'file'
  readonly management: ManagementMode
  readonly sourceId: string
  readonly sourceVersion: number
  readonly lastAppliedHash: string
}

export interface OwnershipManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION
  readonly installationId: string
  readonly wrkrsVersion: string
  readonly installedAt: string
  readonly updatedAt: string
  readonly preset: { readonly id: string; readonly version: number }
  readonly runtimeAdapters: readonly { readonly id: string; readonly version: number }[]
  readonly entries: readonly ManifestEntry[]
  readonly createdDirectories: readonly string[]
}

/** Transaction journal persisted inside .wrkrs while an apply is in flight. */
export type TransactionStatus =
  | 'pending'
  | 'applying'
  | 'validating'
  | 'committed'
  | 'rolling-back'
  | 'rolled-back'
  | 'rollback-incomplete'

export type JournalOperationStatus =
  'planned' | 'staged' | 'published' | 'applied' | 'reverted' | 'retained'

/**
 * Journal operation lifecycle for a created file:
 * planned -> staged (content written and synced at stagingPath, expectedHash recorded)
 *         -> published (target name created atomically; may still be unverified)
 *         -> applied (target re-read and hash-verified)
 * and after a failure: reverted | retained. Directories go planned -> applied.
 */
export interface JournalOperation {
  readonly path: string
  readonly kind: 'create-file' | 'create-directory'
  readonly status: JournalOperationStatus
  readonly stagingPath: string | null
  /** Hash the content must have; recorded before publication so recovery can reconcile. */
  readonly expectedHash: string | null
  readonly appliedHash: string | null
  readonly note: string | null
}

/**
 * 'strict' when every transaction-critical directory entry was fsynced after
 * being created, replaced, or removed; 'best-effort' when the platform could
 * not sync a directory, in which case a power loss before the operating
 * system flushes its caches may revert the most recent entries.
 */
export type TransactionDurability = 'strict' | 'best-effort'

export interface TransactionJournal {
  readonly schemaVersion: 1
  readonly transactionId: string
  readonly command: 'init'
  readonly planDigest: string
  readonly startedAt: string
  readonly updatedAt: string
  readonly status: TransactionStatus
  readonly durability: TransactionDurability
  readonly operations: readonly JournalOperation[]
  readonly failure: string | null
}
