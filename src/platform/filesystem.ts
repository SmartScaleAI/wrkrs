import { AsyncLocalStorage } from 'node:async_hooks'
import { constants as fsConstants, promises as fsp, type Dirent, type Stats } from 'node:fs'
import { isMainThread } from 'node:worker_threads'

import {
  AtomicPublicationUnsupportedError,
  ContainmentError,
  ExclusiveWriteError,
  FileSystemError,
  type BoundDirectory,
  type ContainmentCapability,
  type DirectoryEntry,
  type DirectorySyncResult,
  type FileKind,
  type FileStat,
  type FileSystemPort,
} from '../core/ports.js'

function kindOf(stats: Stats | Dirent): FileKind {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isFile()) return 'file'
  if (stats.isDirectory()) return 'directory'
  return 'other'
}

function toFileStat(stats: Stats): FileStat {
  return { kind: kindOf(stats), size: stats.size, mode: stats.mode & 0o777 }
}

function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === 'string' ? code : 'EUNKNOWN'
}

function mapError(error: unknown, path: string): FileSystemError {
  const code = errnoOf(error)
  return new FileSystemError(code, path, `${code} at ${path}`)
}

function isMissing(error: unknown): boolean {
  const code = errnoOf(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Filesystem identity (device and inode) used to bind a name to the entry that was inspected. */
function identity(stats: Stats): string {
  return `${stats.dev}:${stats.ino}`
}

/** Error codes that mean the filesystem cannot create hard links, not that the target exists. */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'])

/** Error codes that mean the platform cannot fsync a directory, as opposed to a real I/O failure. */
const DIRECTORY_SYNC_UNSUPPORTED = new Set([
  'EISDIR',
  'EPERM',
  'EINVAL',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EBADF',
  'EACCES',
  'ENOSYS',
])

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

function assertName(name: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes(String.fromCharCode(0))
  ) {
    throw new FileSystemError(
      'EINVAL',
      name,
      'Bound directory operations take a single path segment',
    )
  }
}

/**
 * Containment support for this process. The binding mechanism relies on the
 * operating system holding the working directory by inode (POSIX). Windows
 * tracks it by path, so ancestor replacement could redirect relative I/O;
 * worker threads cannot change directory at all. Both fail closed.
 */
export function detectContainmentCapability(): ContainmentCapability {
  if (process.platform === 'win32') {
    return {
      supported: false,
      reason:
        'Windows tracks the working directory by path rather than by directory identity, so wrkrs cannot bind repository directories safely on this platform; full Windows support is planned for the cross-platform increment',
    }
  }
  if (!isMainThread) {
    return {
      supported: false,
      reason:
        'worker threads cannot change the working directory, which wrkrs requires to bind repository directories',
    }
  }
  return { supported: true }
}

/**
 * Process-wide binding coordination. The working directory is one per
 * process, so every Node filesystem instance shares this queue, and a logical
 * binding scope (AsyncLocalStorage) lets a nested withinDirectory call be
 * rejected before it is queued instead of deadlocking behind its parent.
 */
interface BindingScope {
  readonly relativePath: string
}
const bindingScope = new AsyncLocalStorage<BindingScope>()
let schedulerQueue: Promise<unknown> = Promise.resolve()

function changeDirectory(
  target: string,
  code: ContainmentError['code'],
  directory: string,
  ancestor: string | null,
  message: string,
): void {
  try {
    process.chdir(target)
  } catch {
    // The raw chdir error can name arbitrary paths; only the controlled message escapes.
    throw new ContainmentError(code, directory, ancestor, message)
  }
}

/**
 * Binds the process working directory to relativeDirectory beneath root.
 *
 * Each segment is inspected with lstat (never following a symlink), entered
 * with chdir, and then confirmed by comparing the identity of "." with the
 * identity that lstat reported. On POSIX the working directory is held by
 * inode, so once bound, later replacement of any ancestor name cannot
 * redirect relative I/O. If any segment is missing, a symlink, not a
 * directory, cannot be entered, or changed between inspection and entry, a
 * ContainmentError is thrown before any I/O. Returns the bound identity.
 */
async function bind(root: string, relativeDirectory: string): Promise<string> {
  let rootStats: Stats
  try {
    rootStats = await fsp.lstat(root)
  } catch {
    throw new ContainmentError(
      'PATH_ROOT_INVALID',
      relativeDirectory,
      null,
      'repository root is not accessible',
    )
  }
  if (!rootStats.isDirectory()) {
    throw new ContainmentError(
      'PATH_ROOT_INVALID',
      relativeDirectory,
      null,
      'repository root is not a directory',
    )
  }
  changeDirectory(
    root,
    'PATH_ROOT_INVALID',
    relativeDirectory,
    null,
    'repository root could not be entered',
  )
  let current = await currentIdentity('PATH_ROOT_INVALID', relativeDirectory, null)
  if (current !== identity(rootStats)) {
    throw new ContainmentError(
      'PATH_ROOT_INVALID',
      relativeDirectory,
      null,
      'repository root changed while binding',
    )
  }
  if (relativeDirectory === '') return current
  let walked = ''
  for (const segment of relativeDirectory.split('/')) {
    assertName(segment)
    walked = walked === '' ? segment : `${walked}/${segment}`
    let stats: Stats | null
    try {
      stats = await fsp.lstat(segment)
    } catch (error) {
      if (isMissing(error)) {
        stats = null
      } else {
        throw new ContainmentError(
          'PATH_ANCESTOR_CHANGED',
          relativeDirectory,
          walked,
          `"${walked}" could not be inspected`,
        )
      }
    }
    if (!stats) {
      throw new ContainmentError(
        'PATH_ANCESTOR_MISSING',
        relativeDirectory,
        walked,
        `"${walked}" does not exist`,
      )
    }
    if (stats.isSymbolicLink()) {
      throw new ContainmentError(
        'PATH_ANCESTOR_SYMLINK',
        relativeDirectory,
        walked,
        `"${walked}" is a symlink; wrkrs does not read or write through symlinked directories`,
      )
    }
    if (!stats.isDirectory()) {
      throw new ContainmentError(
        'PATH_ANCESTOR_NOT_A_DIRECTORY',
        relativeDirectory,
        walked,
        `"${walked}" is not a directory`,
      )
    }
    changeDirectory(
      segment,
      'PATH_ANCESTOR_CHANGED',
      relativeDirectory,
      walked,
      `"${walked}" changed while it was being bound`,
    )
    current = await currentIdentity('PATH_ANCESTOR_CHANGED', relativeDirectory, walked)
    if (current !== identity(stats)) {
      throw new ContainmentError(
        'PATH_ANCESTOR_CHANGED',
        relativeDirectory,
        walked,
        `"${walked}" changed while it was being bound`,
      )
    }
  }
  return current
}

async function currentIdentity(
  code: ContainmentError['code'],
  directory: string,
  ancestor: string | null,
): Promise<string> {
  try {
    return identity(await fsp.stat('.'))
  } catch {
    throw new ContainmentError(
      code,
      directory,
      ancestor,
      'the bound directory could not be inspected',
    )
  }
}

async function readBound(name: string, maxBytes: number): Promise<Uint8Array> {
  assertName(name)
  let expected: Stats
  try {
    expected = await fsp.lstat(name)
  } catch (error) {
    throw mapError(error, name)
  }
  if (expected.isSymbolicLink()) {
    throw new ContainmentError(
      'PATH_ENTRY_CHANGED',
      '.',
      name,
      `"${name}" is a symlink; wrkrs does not read through symlinks`,
    )
  }
  if (!expected.isFile()) {
    throw new FileSystemError('EISDIR', name, `${name} is not a regular file`)
  }
  if (expected.size > maxBytes) {
    throw new FileSystemError('EFBIG', name, `${name} exceeds the read limit`)
  }
  let handle
  try {
    handle = await fsp.open(name, fsConstants.O_RDONLY | O_NOFOLLOW)
  } catch (error) {
    throw mapError(error, name)
  }
  try {
    const actual = await handle.stat()
    if (identity(actual) !== identity(expected) || !actual.isFile()) {
      throw new ContainmentError(
        'PATH_ENTRY_CHANGED',
        '.',
        name,
        `"${name}" changed between inspection and reading`,
      )
    }
    if (actual.size > maxBytes) {
      throw new FileSystemError('EFBIG', name, `${name} exceeds the read limit`)
    }
    return new Uint8Array(await handle.readFile())
  } catch (error) {
    if (error instanceof ContainmentError || error instanceof FileSystemError) throw error
    throw mapError(error, name)
  } finally {
    await handle.close()
  }
}

interface BoundState {
  active: boolean
}

function boundDirectory(
  relativePath: string,
  boundIdentity: string,
  state: BoundState,
): BoundDirectory {
  /** Every operation re-verifies that it runs inside its callback and inside the bound directory. */
  const guard = async (): Promise<void> => {
    if (!state.active) {
      throw new ContainmentError(
        'BOUND_DIRECTORY_CLOSED',
        relativePath,
        null,
        'the bound directory is no longer valid; its withinDirectory callback has completed',
      )
    }
    const current = await currentIdentity('CONTAINMENT_LOST', relativePath, null)
    if (current !== boundIdentity) {
      throw new ContainmentError(
        'CONTAINMENT_LOST',
        relativePath,
        null,
        'the working directory no longer matches the bound directory',
      )
    }
  }

  return {
    relativePath,

    async lstat(name) {
      await guard()
      assertName(name)
      try {
        return toFileStat(await fsp.lstat(name))
      } catch (error) {
        if (isMissing(error)) return null
        throw mapError(error, name)
      }
    },

    async readFile(name, maxBytes = Number.MAX_SAFE_INTEGER) {
      await guard()
      return readBound(name, maxBytes)
    },

    async readDirectory(): Promise<DirectoryEntry[]> {
      await guard()
      try {
        const entries = await fsp.readdir('.', { withFileTypes: true })
        return entries
          .map((entry) => ({ name: entry.name, kind: kindOf(entry) }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      } catch (error) {
        throw mapError(error, relativePath || '.')
      }
    },

    async writeFileExclusive(name, data, mode) {
      await guard()
      assertName(name)
      let handle
      try {
        handle = await fsp.open(
          name,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
          mode,
        )
      } catch (error) {
        // Nothing was created: EEXIST (someone else's entry) or a real failure.
        throw mapError(error, name)
      }
      // From here on the entry exists and the caller must reconcile it on failure.
      try {
        await handle.writeFile(data)
        await handle.sync()
      } catch (error) {
        await handle.close().catch(() => undefined)
        throw new ExclusiveWriteError(
          errnoOf(error),
          name,
          `${errnoOf(error)} while writing ${name}; the entry was created and may hold partial content`,
        )
      }
      try {
        await handle.close()
      } catch (error) {
        throw new ExclusiveWriteError(
          errnoOf(error),
          name,
          `${errnoOf(error)} while closing ${name}; the entry was created`,
        )
      }
    },

    async linkExclusive(fromName, toName) {
      await guard()
      assertName(fromName)
      assertName(toName)
      try {
        await fsp.link(fromName, toName)
      } catch (error) {
        const code = errnoOf(error)
        if (LINK_UNSUPPORTED.has(code)) {
          throw new AtomicPublicationUnsupportedError(
            code,
            'the filesystem cannot create hard links, so atomic no-replace publication is unavailable',
          )
        }
        throw mapError(error, toName)
      }
    },

    async unlink(name) {
      await guard()
      assertName(name)
      try {
        await fsp.unlink(name)
      } catch (error) {
        throw mapError(error, name)
      }
    },

    async rename(fromName, toName) {
      await guard()
      assertName(fromName)
      assertName(toName)
      try {
        await fsp.rename(fromName, toName)
      } catch (error) {
        throw mapError(error, fromName)
      }
    },

    async makeDirectory(name, mode) {
      await guard()
      assertName(name)
      try {
        await fsp.mkdir(name, { recursive: false, mode })
      } catch (error) {
        throw mapError(error, name)
      }
    },

    async removeDirectory(name) {
      await guard()
      assertName(name)
      try {
        await fsp.rmdir(name)
      } catch (error) {
        throw mapError(error, name)
      }
    },

    async sync(): Promise<DirectorySyncResult> {
      await guard()
      let handle
      try {
        handle = await fsp.open('.', fsConstants.O_RDONLY)
      } catch (error) {
        if (DIRECTORY_SYNC_UNSUPPORTED.has(errnoOf(error))) return 'unsupported'
        throw mapError(error, relativePath || '.')
      }
      try {
        await handle.sync()
        return 'synced'
      } catch (error) {
        if (DIRECTORY_SYNC_UNSUPPORTED.has(errnoOf(error))) return 'unsupported'
        throw mapError(error, relativePath || '.')
      } finally {
        await handle.close()
      }
    },
  }
}

export interface NodeFileSystemOptions {
  /** Overrides the detected containment capability (tests use this to simulate other platforms). */
  readonly containment?: ContainmentCapability
}

/**
 * Node-backed filesystem port. Repository content is reachable only through
 * withinDirectory, which binds the process working directory to a verified
 * directory for the duration of one callback. All instances share one
 * process-wide scheduler; nested calls are rejected immediately; the
 * previous working directory is restored after every operation.
 */
export function createNodeFileSystem(options: NodeFileSystemOptions = {}): FileSystemPort {
  const containment = options.containment ?? detectContainmentCapability()

  async function run<T>(
    root: string,
    relativeDirectory: string,
    operation: (directory: BoundDirectory) => Promise<T>,
  ): Promise<T> {
    const savedCwd = process.cwd()
    const state: BoundState = { active: false }
    try {
      const boundIdentity = await bind(root, relativeDirectory)
      state.active = true
      return await bindingScope.run({ relativePath: relativeDirectory }, () =>
        operation(boundDirectory(relativeDirectory, boundIdentity, state)),
      )
    } finally {
      state.active = false
      try {
        process.chdir(savedCwd)
      } catch {
        try {
          process.chdir(root)
        } catch {
          // The original working directory disappeared; nothing else can be done.
        }
      }
    }
  }

  return {
    containment,

    async lstat(path): Promise<FileStat | null> {
      try {
        return toFileStat(await fsp.lstat(path))
      } catch (error) {
        if (isMissing(error)) return null
        throw mapError(error, path)
      }
    },

    async realpath(path) {
      try {
        return await fsp.realpath(path)
      } catch (error) {
        if (isMissing(error)) return null
        throw mapError(error, path)
      }
    },

    withinDirectory(root, relativeDirectory, operation) {
      if (!containment.supported) {
        return Promise.reject(
          new ContainmentError(
            'CONTAINMENT_UNSUPPORTED',
            relativeDirectory,
            null,
            containment.reason,
          ),
        )
      }
      // Reentrancy is detected synchronously, before queuing, so a nested
      // call from inside a callback rejects instead of waiting on itself.
      if (bindingScope.getStore()) {
        return Promise.reject(
          new ContainmentError(
            'CONTAINMENT_REENTRANT',
            relativeDirectory,
            null,
            'withinDirectory cannot be nested; complete the outer operation first',
          ),
        )
      }
      const next = schedulerQueue.then(
        () => run(root, relativeDirectory, operation),
        () => run(root, relativeDirectory, operation),
      )
      schedulerQueue = next.catch(() => undefined)
      return next
    },
  }
}
