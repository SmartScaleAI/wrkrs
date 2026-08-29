/**
 * Port interfaces. The core depends on these abstractions only; Node-backed
 * implementations live under src/platform and tests may inject fakes,
 * fault injectors, fixed clocks, and sequential identifiers.
 */

export type FileKind = 'file' | 'directory' | 'symlink' | 'other'

export interface FileStat {
  readonly kind: FileKind
  readonly size: number
  /** Permission bits only (mode & 0o777). */
  readonly mode: number
}

export interface DirectoryEntry {
  readonly name: string
  readonly kind: FileKind
}

export class FileSystemError extends Error {
  readonly code: string
  readonly path: string

  constructor(code: string, path: string, message: string) {
    super(message)
    this.name = 'FileSystemError'
    this.code = code
    this.path = path
  }
}

export interface FileSystemPort {
  /** lstat semantics: a symlink is reported as a symlink. Returns null when absent. */
  lstat(path: string): Promise<FileStat | null>
  /** Resolves symlinks; returns null when the path does not exist. */
  realpath(path: string): Promise<string | null>
  readFile(path: string): Promise<Uint8Array>
  /** Entries sorted by name for deterministic scanning. */
  readDirectory(path: string): Promise<readonly DirectoryEntry[]>
  /** Creates a new file; fails with EEXIST when the path already exists. */
  writeFileExclusive(path: string, data: Uint8Array, mode: number): Promise<void>
  /** Overwrites or creates a file. Used only for wrkrs transaction bookkeeping. */
  writeFile(path: string, data: Uint8Array, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  /** Creates one directory level; fails with EEXIST when it already exists. */
  makeDirectory(path: string, mode: number): Promise<void>
  /** Removes an empty directory; fails with ENOTEMPTY otherwise. */
  removeDirectory(path: string): Promise<void>
}

export interface ProcessResult {
  readonly started: boolean
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly errorCode: string | null
}

export interface ProcessPort {
  /** Executes a program without a shell. Arguments are passed as an array. */
  run(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<ProcessResult>
}

export interface ClockPort {
  now(): Date
}

export interface IdPort {
  uuid(): string
}

export interface PromptPort {
  readonly interactive: boolean
  confirm(message: string): Promise<boolean>
}

export interface EnvironmentPort {
  readonly nodeVersion: string
  readonly platform: string
  /** PATH entries used for optional executable detection. */
  readonly executablePaths: readonly string[]
  readonly pathExtensions: readonly string[]
  readonly processId: number
}
