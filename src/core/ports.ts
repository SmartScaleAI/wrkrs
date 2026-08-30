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

/**
 * Raised by an exclusive write that failed after the O_EXCL entry was created
 * (write, sync, or close failed). `created` is always true: the caller must
 * reconcile the named entry, which may hold partial content. Failures before
 * creation (for example EEXIST) surface as FileSystemError instead, and the
 * entry then belongs to someone else.
 */
export class ExclusiveWriteError extends Error {
  readonly code: string
  readonly entryName: string
  readonly created = true as const

  constructor(code: string, entryName: string, message: string) {
    super(message)
    this.name = 'ExclusiveWriteError'
    this.code = code
    this.entryName = entryName
  }
}

export type ContainmentErrorCode =
  | 'PATH_ROOT_INVALID'
  | 'PATH_ANCESTOR_MISSING'
  | 'PATH_ANCESTOR_SYMLINK'
  | 'PATH_ANCESTOR_NOT_A_DIRECTORY'
  | 'PATH_ANCESTOR_CHANGED'
  | 'PATH_ENTRY_CHANGED'
  | 'CONTAINMENT_UNSUPPORTED'
  | 'CONTAINMENT_REENTRANT'
  | 'CONTAINMENT_LOST'
  | 'BOUND_DIRECTORY_CLOSED'

/**
 * Raised when a directory cannot be bound without leaving the repository, or
 * when the binding discipline is violated: an ancestor is missing, is a
 * symlink, is not a directory, or changed identity between inspection and
 * binding; the platform cannot bind at all; a bound operation was nested;
 * the working directory no longer matches the bound directory; or a bound
 * directory was used after its callback finished. Nothing is read or written
 * when this is thrown. Messages are controlled and never include file content.
 */
export class ContainmentError extends Error {
  readonly code: ContainmentErrorCode
  /** Repository-relative directory that was requested. */
  readonly directory: string
  /** Repository-relative path of the segment that failed, when applicable. */
  readonly ancestor: string | null

  constructor(
    code: ContainmentErrorCode,
    directory: string,
    ancestor: string | null,
    message: string,
  ) {
    super(message)
    this.name = 'ContainmentError'
    this.code = code
    this.directory = directory
    this.ancestor = ancestor
  }
}

/**
 * Raised when the filesystem cannot create a hard link, which is the only
 * atomic no-replace publication primitive wrkrs uses. wrkrs fails closed
 * instead of falling back to a non-atomic copy.
 */
export class AtomicPublicationUnsupportedError extends Error {
  readonly code = 'ATOMIC_PUBLICATION_UNSUPPORTED'
  readonly errno: string

  constructor(errno: string, message: string) {
    super(message)
    this.name = 'AtomicPublicationUnsupportedError'
    this.errno = errno
  }
}

/** Result of syncing a directory's entries to stable storage. */
export type DirectorySyncResult = 'synced' | 'unsupported'

/**
 * Whether the port can bind directories so that validation and I/O are one
 * step. When unsupported, wrkrs must not read, create, modify, or remove
 * repository content at all; the reason is a controlled, printable sentence.
 */
export type ContainmentCapability =
  { readonly supported: true } | { readonly supported: false; readonly reason: string }

/**
 * Operations on a directory that has been bound (its identity verified and
 * held) so that names resolve inside that directory regardless of later
 * changes to any ancestor. Names are single path segments; they never contain
 * separators, and the final segment is never followed when it is a symlink.
 * A BoundDirectory is valid only inside the withinDirectory callback that
 * produced it; every method re-verifies that the working directory still is
 * the bound directory and fails closed otherwise.
 */
export interface BoundDirectory {
  /** Repository-relative path of the bound directory ('' for the root). */
  readonly relativePath: string
  lstat(name: string): Promise<FileStat | null>
  /**
   * Reads a regular file without following a symlink at name. The opened
   * handle must have the identity lstat reported; otherwise the read fails
   * with ContainmentError PATH_ENTRY_CHANGED and nothing is returned.
   */
  readFile(name: string, maxBytes?: number): Promise<Uint8Array>
  /** Entries sorted by name. */
  readDirectory(): Promise<readonly DirectoryEntry[]>
  /**
   * Creates a new file (O_EXCL, no follow), writes all bytes, and syncs them.
   * Fails with FileSystemError (EEXIST and friends) when nothing was created
   * and with ExclusiveWriteError when the entry exists but the write, sync, or
   * close failed; the caller owns reconciling that entry.
   */
  writeFileExclusive(name: string, data: Uint8Array, mode: number): Promise<void>
  /**
   * Atomically creates toName as a hard link of fromName. Fails with EEXIST
   * for any existing entry, and with AtomicPublicationUnsupportedError when the
   * filesystem cannot create hard links. Never replaces anything.
   */
  linkExclusive(fromName: string, toName: string): Promise<void>
  unlink(name: string): Promise<void>
  /** Replaces toName with fromName atomically. Used only for wrkrs bookkeeping files. */
  rename(fromName: string, toName: string): Promise<void>
  makeDirectory(name: string, mode: number): Promise<void>
  removeDirectory(name: string): Promise<void>
  /**
   * Syncs this directory's entries to stable storage. Returns 'unsupported'
   * when the platform cannot sync a directory; throws FileSystemError on a
   * real I/O failure, which callers must never swallow.
   */
  sync(): Promise<DirectorySyncResult>
}

export interface FileSystemPort {
  /** Whether withinDirectory can bind directories on this platform and thread. */
  readonly containment: ContainmentCapability
  /** lstat semantics: a symlink is reported as a symlink. Returns null when absent. */
  lstat(path: string): Promise<FileStat | null>
  /** Resolves symlinks; returns null when the path does not exist. */
  realpath(path: string): Promise<string | null>
  /**
   * Binds relativeDirectory beneath root (verifying every ancestor with lstat
   * and directory identity, refusing symlinks) and runs operation against it.
   * Throws ContainmentError before any I/O when the directory cannot be bound,
   * when containment is unsupported, or when called from inside another
   * withinDirectory callback.
   */
  withinDirectory<T>(
    root: string,
    relativeDirectory: string,
    operation: (directory: BoundDirectory) => Promise<T>,
  ): Promise<T>
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
