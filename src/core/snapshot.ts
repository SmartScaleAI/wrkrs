import type { Finding } from './findings.js'
import type { OwnershipManifest } from './ownership.js'
import type { FileKind } from './ports.js'

/** A project signal is a deterministic observation used for specialization evidence. */
export interface ProjectSignal {
  readonly id: string
  readonly path: string
  readonly detail: string
}

export interface FileSnapshot {
  readonly path: string
  readonly kind: FileKind
  readonly size: number
  readonly mode: number
  /** SHA-256 over exact bytes for regular files; null for other kinds. */
  readonly hash: string | null
}

export interface GitSnapshot {
  readonly root: string
  readonly dirty: boolean
}

export interface ClaudeComponentSnapshot {
  readonly path: string
  /** Frontmatter name when parseable; never file content. */
  readonly name: string | null
}

export interface ClaudeSettingsSnapshot {
  readonly path: string
  readonly valid: boolean
  readonly hookEvents: readonly string[]
  readonly hookCount: number
  readonly permissionRuleCounts: {
    readonly allow: number
    readonly deny: number
    readonly ask: number
  }
}

export interface McpServerSnapshot {
  readonly name: string
  readonly transport: string
}

export interface McpSnapshot {
  readonly path: string
  readonly valid: boolean
  readonly servers: readonly McpServerSnapshot[]
}

export interface ClaudeSnapshot {
  readonly claudeMd: string | null
  readonly claudeLocalMd: string | null
  readonly settings: ClaudeSettingsSnapshot | null
  readonly settingsLocal: ClaudeSettingsSnapshot | null
  readonly agents: readonly ClaudeComponentSnapshot[]
  readonly skills: readonly ClaudeComponentSnapshot[]
  readonly commands: readonly ClaudeComponentSnapshot[]
  readonly hooks: readonly ClaudeComponentSnapshot[]
  readonly mcp: McpSnapshot | null
}

export interface WrkrsConfigSnapshot {
  readonly path: string
  readonly valid: boolean
  readonly schemaVersion: number | null
  readonly error: string | null
}

export interface WrkrsManifestSnapshot {
  readonly path: string
  readonly valid: boolean
  /** Migrated in memory to the current format; the file on disk is unchanged. */
  readonly manifest: OwnershipManifest | null
  /** Schema version of the document on disk, before any in-memory migration. */
  readonly sourceSchemaVersion: number | null
  readonly error: string | null
}

export interface WrkrsJournalSnapshot {
  readonly path: string
  readonly transactionId: string | null
  readonly status: string | null
}

export interface WrkrsSnapshot {
  readonly directoryKind: FileKind | null
  readonly config: WrkrsConfigSnapshot | null
  readonly manifest: WrkrsManifestSnapshot | null
  readonly lockPresent: boolean
  readonly journal: WrkrsJournalSnapshot | null
}

/** Why a path could not be reached without leaving the worktree. */
export type ContainmentState =
  'ok' | 'ancestor-symlink' | 'ancestor-not-directory' | 'escapes-root' | 'invalid-path'

export interface AncestorSnapshot {
  readonly path: string
  /** lstat kind, or null when the ancestor does not exist. */
  readonly kind: FileKind | null
}

/**
 * Exact state of one desired generated target, captured independently of the
 * bounded generic index so truncation can never misclassify a known target.
 */
export interface TargetSnapshot {
  readonly path: string
  readonly containment: ContainmentState
  readonly blockingAncestor: string | null
  /** Ancestors shallowest first, ending at the first absent one. */
  readonly ancestors: readonly AncestorSnapshot[]
  /** Exact lstat (and hash for regular files) of the target, or null when absent. */
  readonly file: FileSnapshot | null
}

/** Names present in one directory, used for case-folded collision proofs. */
export interface DirectoryListing {
  readonly path: string
  readonly names: readonly string[]
  /** False when the directory held more entries than the listing bound. */
  readonly complete: boolean
}

export interface ScanSummary {
  /** True when the generic .claude/.wrkrs index hit its entry or depth bound. */
  readonly indexTruncated: boolean
  readonly listingLimit: number
}

export interface RepositorySnapshot {
  readonly root: string
  readonly git: GitSnapshot
  readonly projectSignals: readonly ProjectSignal[]
  readonly claude: ClaudeSnapshot
  readonly wrkrs: WrkrsSnapshot
  /** Bounded index of paths relevant to planning, keyed by normalized relative path. */
  readonly files: ReadonlyMap<string, FileSnapshot>
  /** Exact snapshots of desired generated targets (see snapshotTargets). */
  readonly targets: ReadonlyMap<string, TargetSnapshot>
  /** Directory listings for the parents of desired targets and their ancestors. */
  readonly listings: ReadonlyMap<string, DirectoryListing>
  readonly scan: ScanSummary
  readonly findings: readonly Finding[]
}
