import { constants as fsConstants, promises as fsp, type Dirent, type Stats } from 'node:fs'

import {
  FileSystemError,
  type DirectoryEntry,
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

function mapError(error: unknown, path: string): FileSystemError {
  const failure = error as NodeJS.ErrnoException
  const code = typeof failure?.code === 'string' ? failure.code : 'EUNKNOWN'
  const message = failure?.message ?? String(error)
  return new FileSystemError(code, path, message)
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Error codes that mean the filesystem cannot create hard links, not that the target exists. */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'])

/**
 * Atomic no-replace publication. A hard link creates the target name only if
 * it does not already exist (link(2) fails with EEXIST for files, directories,
 * and symlinks alike) and never replaces anything. When the filesystem cannot
 * create hard links, copyFile with COPYFILE_EXCL is used: it also refuses to
 * replace an existing target, at the cost of a non-atomic content copy that the
 * caller's post-publication hash verification covers.
 */
async function publishFileExclusive(stagingPath: string, targetPath: string): Promise<void> {
  try {
    await fsp.link(stagingPath, targetPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (typeof code !== 'string' || !LINK_UNSUPPORTED.has(code)) {
      throw mapError(error, targetPath)
    }
    try {
      await fsp.copyFile(stagingPath, targetPath, fsConstants.COPYFILE_EXCL)
    } catch (copyError) {
      throw mapError(copyError, targetPath)
    }
  }
  try {
    await fsp.unlink(stagingPath)
  } catch (error) {
    if (!isMissing(error)) throw mapError(error, stagingPath)
  }
}

async function writeWithFlag(
  path: string,
  data: Uint8Array,
  mode: number,
  flag: 'wx' | 'w',
): Promise<void> {
  let handle
  try {
    handle = await fsp.open(path, flag, mode)
  } catch (error) {
    throw mapError(error, path)
  }
  try {
    await handle.writeFile(data)
    await handle.sync()
  } catch (error) {
    throw mapError(error, path)
  } finally {
    await handle.close()
  }
}

/** Node-backed filesystem port. All methods surface FileSystemError with the errno code. */
export function createNodeFileSystem(): FileSystemPort {
  return {
    async lstat(path): Promise<FileStat | null> {
      try {
        const stats = await fsp.lstat(path)
        return { kind: kindOf(stats), size: stats.size, mode: stats.mode & 0o777 }
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

    async readFile(path) {
      try {
        return new Uint8Array(await fsp.readFile(path))
      } catch (error) {
        throw mapError(error, path)
      }
    },

    async readDirectory(path): Promise<DirectoryEntry[]> {
      try {
        const entries = await fsp.readdir(path, { withFileTypes: true })
        return entries
          .map((entry) => ({ name: entry.name, kind: kindOf(entry) }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      } catch (error) {
        throw mapError(error, path)
      }
    },

    writeFileExclusive(path, data, mode) {
      return writeWithFlag(path, data, mode, 'wx')
    },

    writeFile(path, data, mode) {
      return writeWithFlag(path, data, mode, 'w')
    },

    publishFileExclusive,

    async rename(from, to) {
      try {
        await fsp.rename(from, to)
      } catch (error) {
        throw mapError(error, from)
      }
    },

    async unlink(path) {
      try {
        await fsp.unlink(path)
      } catch (error) {
        throw mapError(error, path)
      }
    },

    async makeDirectory(path, mode) {
      try {
        await fsp.mkdir(path, { recursive: false, mode })
      } catch (error) {
        throw mapError(error, path)
      }
    },

    async removeDirectory(path) {
      try {
        await fsp.rmdir(path)
      } catch (error) {
        throw mapError(error, path)
      }
    },
  }
}
