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
  readonly manifest: OwnershipManifest | null
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

export interface RepositorySnapshot {
  readonly root: string
  readonly git: GitSnapshot
  readonly projectSignals: readonly ProjectSignal[]
  readonly claude: ClaudeSnapshot
  readonly wrkrs: WrkrsSnapshot
  /** Bounded index of paths relevant to planning, keyed by normalized relative path. */
  readonly files: ReadonlyMap<string, FileSnapshot>
  readonly findings: readonly Finding[]
}
