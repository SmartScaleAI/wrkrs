/**
 * Ownership manifest contract and well-known repository paths.
 */
export const MANIFEST_SCHEMA_VERSION = 2

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

/**
 * Lifecycle state of an installation. `partial-uninstall` is the residue an
 * uninstall leaves when it preserved a customized or drifted entry: the
 * remaining manifest lists only what stayed, so a later retry is safe and
 * `wrkrs check` never calls a half-removed installation healthy.
 */
export const INSTALLATION_STATES = ['installed', 'partial-uninstall'] as const
export type InstallationState = (typeof INSTALLATION_STATES)[number]

export interface OwnershipManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION
  readonly state: InstallationState
  readonly installationId: string
  readonly wrkrsVersion: string
  readonly installedAt: string
  readonly updatedAt: string
  readonly preset: { readonly id: string; readonly version: number }
  readonly runtimeAdapters: readonly { readonly id: string; readonly version: number }[]
  readonly entries: readonly ManifestEntry[]
  readonly createdDirectories: readonly string[]
}

/** Command that owns a transaction journal. */
export type JournalCommand = 'init' | 'update' | 'uninstall'

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
  | 'planned'
  | 'staging'
  | 'staged'
  | 'backed-up'
  | 'published'
  | 'applied'
  | 'removed'
  | 'reverted'
  | 'retained'

/**
 * Journal operation lifecycles. Every status is recorded before the step that
 * can make it true, so no failure can hide a name wrkrs created or a file it
 * replaced or removed.
 *
 * create-file:
 * planned -> staging (stagingPath announced before the exclusive write; the entry may exist)
 *         -> staged (content written and synced at stagingPath, expectedHash recorded)
 *         -> published (target name created atomically; stagingPath kept until its removal is proven)
 *         -> applied (target re-read and hash-verified)
 *
 * replace-file:
 * planned -> staging -> staged
 *         -> backed-up (backupPath is a hard link to the original entry, so the
 *            previous bytes and mode survive until the replacement is verified)
 *         -> published (staging renamed over the target; the target now holds new bytes)
 *         -> applied (target re-read and hash-verified; backupPath kept until removal is proven)
 *
 * remove-file:
 * planned -> backed-up (backupPath is a hard link to the entry about to be unlinked)
 *         -> removed (target unlinked and proven absent; backupPath kept until removal is proven)
 *
 * create-directory: planned -> applied. remove-directory: planned -> removed.
 *
 * After a failure every kind ends in reverted | retained.
 */
export type JournalOperationKind =
  'create-file' | 'create-directory' | 'replace-file' | 'remove-file' | 'remove-directory'

export interface JournalOperation {
  readonly path: string
  readonly kind: JournalOperationKind
  readonly status: JournalOperationStatus
  readonly stagingPath: string | null
  /**
   * Hard link to the entry as it was before a replacement or removal, kept in
   * the target's own directory so rollback can restore the exact inode. Null
   * for a pure create and once its removal is proven.
   */
  readonly backupPath: string | null
  /** Hash of the bytes the backup holds, so rollback restores only proven content. */
  readonly backupHash: string | null
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
  readonly command: JournalCommand
  readonly planDigest: string
  readonly startedAt: string
  readonly updatedAt: string
  readonly status: TransactionStatus
  readonly durability: TransactionDurability
  readonly operations: readonly JournalOperation[]
  readonly failure: string | null
}
