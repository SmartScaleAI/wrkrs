import {
  constants as fsConstants,
  lstatSync,
  promises as fsp,
  statSync,
  type Dirent,
  type Stats,
} from 'node:fs'

import {
  AtomicPublicationUnsupportedError,
  ContainmentError,
  FileSystemError,
  type BoundDirectory,
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

function mapError(error: unknown, path: string): FileSystemError {
  const failure = error as NodeJS.ErrnoException
  const code = typeof failure?.code === 'string' ? failure.code : 'EUNKNOWN'
  return new FileSystemError(code, path, `${code} at ${path}`)
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
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
 * Binds the process working directory to relativeDirectory beneath root.
 *
 * Each segment is inspected with lstat (never following a symlink), entered
 * with chdir, and then confirmed by comparing the identity of "." with the
 * identity that lstat reported. On POSIX the working directory is held by
 * inode, so once bound, later replacement of any ancestor name cannot
 * redirect relative I/O. If any segment is missing, a symlink, not a
 * directory, or changed between inspection and entry, a ContainmentError is
 * thrown before any I/O.
 */
function bind(root: string, relativeDirectory: string): void {
  let rootStats: Stats
  try {
    rootStats = lstatSync(root)
  } catch (error) {
    throw new ContainmentError(
      'PATH_ROOT_INVALID',
      relativeDirectory,
      null,
      `repository root is not accessible (${(error as NodeJS.ErrnoException).code ?? 'error'})`,
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
  process.chdir(root)
  if (identity(statSync('.')) !== identity(rootStats)) {
    throw new ContainmentError(
      'PATH_ROOT_INVALID',
      relativeDirectory,
      null,
      'repository root changed while binding',
    )
  }
  if (relativeDirectory === '') return
  let walked = ''
  for (const segment of relativeDirectory.split('/')) {
    assertName(segment)
    walked = walked === '' ? segment : `${walked}/${segment}`
    const stats = lstatSync(segment, { throwIfNoEntry: false })
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
    process.chdir(segment)
    if (identity(statSync('.')) !== identity(stats)) {
      throw new ContainmentError(
        'PATH_ANCESTOR_CHANGED',
        relativeDirectory,
        walked,
        `"${walked}" changed while it was being bound`,
      )
    }
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

function boundDirectory(relativePath: string): BoundDirectory {
  return {
    relativePath,

    async lstat(name) {
      assertName(name)
      try {
        return toFileStat(await fsp.lstat(name))
      } catch (error) {
        if (isMissing(error)) return null
        throw mapError(error, name)
      }
    },

    readFile(name, maxBytes = Number.MAX_SAFE_INTEGER) {
      return readBound(name, maxBytes)
    },

    async readDirectory(): Promise<DirectoryEntry[]> {
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
      assertName(name)
      let handle
      try {
        handle = await fsp.open(
          name,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
          mode,
        )
      } catch (error) {
        throw mapError(error, name)
      }
      try {
        await handle.writeFile(data)
        await handle.sync()
      } catch (error) {
        throw mapError(error, name)
      } finally {
        await handle.close()
      }
    },

    async linkExclusive(fromName, toName) {
      assertName(fromName)
      assertName(toName)
      try {
        await fsp.link(fromName, toName)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (typeof code === 'string' && LINK_UNSUPPORTED.has(code)) {
          throw new AtomicPublicationUnsupportedError(
            code,
            'the filesystem cannot create hard links, so atomic no-replace publication is unavailable',
          )
        }
        throw mapError(error, toName)
      }
    },

    async unlink(name) {
      assertName(name)
      try {
        await fsp.unlink(name)
      } catch (error) {
        throw mapError(error, name)
      }
    },

    async rename(fromName, toName) {
      assertName(fromName)
      assertName(toName)
      try {
        await fsp.rename(fromName, toName)
      } catch (error) {
        throw mapError(error, fromName)
      }
    },

    async makeDirectory(name, mode) {
      assertName(name)
      try {
        await fsp.mkdir(name, { recursive: false, mode })
      } catch (error) {
        throw mapError(error, name)
      }
    },

    async removeDirectory(name) {
      assertName(name)
      try {
        await fsp.rmdir(name)
      } catch (error) {
        throw mapError(error, name)
      }
    },

    async sync(): Promise<DirectorySyncResult> {
      let handle
      try {
        handle = await fsp.open('.', fsConstants.O_RDONLY)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (typeof code === 'string' && DIRECTORY_SYNC_UNSUPPORTED.has(code)) return 'unsupported'
        throw mapError(error, relativePath || '.')
      }
      try {
        await handle.sync()
        return 'synced'
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (typeof code === 'string' && DIRECTORY_SYNC_UNSUPPORTED.has(code)) return 'unsupported'
        throw mapError(error, relativePath || '.')
      } finally {
        await handle.close()
      }
    },
  }
}

/**
 * Node-backed filesystem port. Repository content is reachable only through
 * withinDirectory, which binds the process working directory to a verified
 * directory for the duration of one operation. Calls are serialized because
 * the working directory is process-wide; nesting is rejected.
 */
export function createNodeFileSystem(): FileSystemPort {
  let queue: Promise<unknown> = Promise.resolve()
  let active = false

  async function run<T>(
    root: string,
    relativeDirectory: string,
    operation: (directory: BoundDirectory) => Promise<T>,
  ): Promise<T> {
    if (active) {
      throw new Error('withinDirectory cannot be nested; complete the outer operation first')
    }
    active = true
    const savedCwd = process.cwd()
    try {
      bind(root, relativeDirectory)
      return await operation(boundDirectory(relativeDirectory))
    } finally {
      try {
        process.chdir(savedCwd)
      } catch {
        try {
          process.chdir(root)
        } catch {
          // The original working directory disappeared; nothing else can be done.
        }
      }
      active = false
    }
  }

  return {
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
      const next = queue.then(
        () => run(root, relativeDirectory, operation),
        () => run(root, relativeDirectory, operation),
      )
      queue = next.catch(() => undefined)
      return next
    },
  }
}
