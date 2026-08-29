import { promises as fsp, type Dirent, type Stats } from 'node:fs'

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
