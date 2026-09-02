import {
  ContainmentError,
  FileSystemError,
  type DirectoryEntry,
  type FileStat,
  type FileSystemPort,
} from '../core/ports.js'
import { err, ok, type Result } from '../core/result.js'
import { baseName, normalizeRelativePath, parentDirectory, toSystemPath } from './paths.js'

export type ContainmentFailureCode =
  | 'CONTAINMENT_UNAVAILABLE'
  | 'PATH_INVALID'
  | 'PATH_ANCESTOR_SYMLINK'
  | 'PATH_ANCESTOR_NOT_A_DIRECTORY'
  | 'PATH_ANCESTOR_CHANGED'
  | 'PATH_ESCAPES_ROOT'
  | 'PATH_TARGET_SYMLINK'
  | 'PATH_ENTRY_CHANGED'
  | 'PATH_NOT_A_FILE'
  | 'PATH_NOT_A_DIRECTORY'
  | 'PATH_TOO_LARGE'

export interface ContainmentFailure {
  readonly code: ContainmentFailureCode
  /** Requested repository-relative path (as given, not normalized when invalid). */
  readonly path: string
  /** The ancestor that caused the failure, when applicable. */
  readonly ancestor: string | null
  /** Controlled message: never includes file content. */
  readonly message: string
}

export interface ResolvedPath {
  readonly relativePath: string
  readonly systemPath: string
  /** lstat of the final segment, or null when absent. */
  readonly stat: FileStat | null
}

export const DEFAULT_MAX_READ_BYTES = 1024 * 1024

/**
 * Safe read boundary for the selected worktree. Every access binds the
 * parent directory through FileSystemPort.withinDirectory, which verifies
 * each ancestor and holds the directory for the duration of the operation, so
 * validation and the read are one step: no cached verification, no read by
 * pathname, no symlinked ancestor or target ever followed. The scanner,
 * `wrkrs check`, precondition rechecks, and adapter validation all share it.
 */
export interface RepositoryReader {
  readonly root: string
  readonly realRoot: string
  resolve(relativePath: string): Promise<Result<ResolvedPath, ContainmentFailure>>
  readBytes(
    relativePath: string,
    maxBytes?: number,
  ): Promise<Result<Uint8Array | null, ContainmentFailure>>
  readText(
    relativePath: string,
    maxBytes?: number,
  ): Promise<Result<string | null, ContainmentFailure>>
  /** Entries of a real directory; null when absent. The empty path lists the root. */
  listDirectory(
    relativePath: string,
  ): Promise<Result<readonly DirectoryEntry[] | null, ContainmentFailure>>
}

function failure(
  code: ContainmentFailureCode,
  path: string,
  ancestor: string | null,
  message: string,
): ContainmentFailure {
  return { code, path, ancestor, message }
}

/** Maps a binding failure to a reader failure; a missing ancestor means the path is absent. */
function fromContainmentError(
  error: ContainmentError,
  path: string,
): Result<null, ContainmentFailure> {
  switch (error.code) {
    case 'PATH_ANCESTOR_MISSING':
      return ok(null)
    case 'PATH_ANCESTOR_SYMLINK':
      return err(failure('PATH_ANCESTOR_SYMLINK', path, error.ancestor, error.message))
    case 'PATH_ANCESTOR_NOT_A_DIRECTORY':
      return err(failure('PATH_ANCESTOR_NOT_A_DIRECTORY', path, error.ancestor, error.message))
    case 'PATH_ANCESTOR_CHANGED':
      return err(failure('PATH_ANCESTOR_CHANGED', path, error.ancestor, error.message))
    case 'PATH_ENTRY_CHANGED':
      return err(failure('PATH_ENTRY_CHANGED', path, null, error.message))
    case 'PATH_ROOT_INVALID':
      return err(failure('PATH_ESCAPES_ROOT', path, null, error.message))
    case 'CONTAINMENT_UNSUPPORTED':
    case 'CONTAINMENT_REENTRANT':
    case 'CONTAINMENT_LOST':
    case 'BOUND_DIRECTORY_CLOSED':
      return err(failure('CONTAINMENT_UNAVAILABLE', path, null, error.message))
  }
}

export async function createRepositoryReader(
  root: string,
  fs: FileSystemPort,
): Promise<RepositoryReader> {
  const realRoot = (await fs.realpath(root)) ?? root
  const decoder = new TextDecoder('utf-8', { fatal: false })

  async function resolve(relativePath: string): Promise<Result<ResolvedPath, ContainmentFailure>> {
    if (relativePath === '') {
      return ok({ relativePath: '', systemPath: root, stat: await fs.lstat(root) })
    }
    const normalized = normalizeRelativePath(relativePath)
    if (!normalized.ok) {
      return err(failure('PATH_INVALID', relativePath, null, normalized.error.message))
    }
    const path = normalized.value
    const directory = parentDirectory(path) ?? ''
    const name = baseName(path)
    try {
      const stat = await fs.withinDirectory(root, directory, (bound) => bound.lstat(name))
      return ok({ relativePath: path, systemPath: toSystemPath(root, path), stat })
    } catch (error) {
      if (error instanceof ContainmentError) {
        const mapped = fromContainmentError(error, path)
        if (!mapped.ok) return mapped
        return ok({ relativePath: path, systemPath: toSystemPath(root, path), stat: null })
      }
      throw error
    }
  }

  async function readBytes(
    relativePath: string,
    maxBytes = DEFAULT_MAX_READ_BYTES,
  ): Promise<Result<Uint8Array | null, ContainmentFailure>> {
    const resolved = await resolve(relativePath)
    if (!resolved.ok) return resolved
    const { stat, relativePath: path } = resolved.value
    if (!stat) return ok(null)
    if (stat.kind === 'symlink') {
      return err(
        failure(
          'PATH_TARGET_SYMLINK',
          path,
          null,
          `"${path}" is a symlink; wrkrs does not read through symlinks`,
        ),
      )
    }
    if (stat.kind !== 'file') {
      return err(
        failure('PATH_NOT_A_FILE', path, null, `"${path}" is a ${stat.kind}, not a regular file`),
      )
    }
    if (stat.size > maxBytes) {
      return err(
        failure('PATH_TOO_LARGE', path, null, `"${path}" exceeds the ${maxBytes}-byte read limit`),
      )
    }
    const directory = parentDirectory(path) ?? ''
    const name = baseName(path)
    try {
      const bytes = await fs.withinDirectory(root, directory, (bound) =>
        bound.readFile(name, maxBytes),
      )
      return ok(bytes)
    } catch (error) {
      if (error instanceof ContainmentError) {
        const mapped = fromContainmentError(error, path)
        return mapped.ok ? ok(null) : mapped
      }
      if (error instanceof FileSystemError) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return ok(null)
        if (error.code === 'EFBIG') {
          return err(
            failure(
              'PATH_TOO_LARGE',
              path,
              null,
              `"${path}" exceeds the ${maxBytes}-byte read limit`,
            ),
          )
        }
        if (error.code === 'EISDIR') {
          return err(failure('PATH_NOT_A_FILE', path, null, `"${path}" is not a regular file`))
        }
      }
      throw error
    }
  }

  async function readText(
    relativePath: string,
    maxBytes = DEFAULT_MAX_READ_BYTES,
  ): Promise<Result<string | null, ContainmentFailure>> {
    const bytes = await readBytes(relativePath, maxBytes)
    if (!bytes.ok) return bytes
    return ok(bytes.value === null ? null : decoder.decode(bytes.value))
  }

  async function listDirectory(
    relativePath: string,
  ): Promise<Result<readonly DirectoryEntry[] | null, ContainmentFailure>> {
    let path = ''
    if (relativePath !== '') {
      const normalized = normalizeRelativePath(relativePath)
      if (!normalized.ok) {
        return err(failure('PATH_INVALID', relativePath, null, normalized.error.message))
      }
      path = normalized.value
    }
    try {
      const entries = await fs.withinDirectory(root, path, (bound) => bound.readDirectory())
      return ok(entries)
    } catch (error) {
      if (error instanceof ContainmentError) {
        if (error.ancestor === path && path !== '') {
          if (error.code === 'PATH_ANCESTOR_MISSING') return ok(null)
          if (error.code === 'PATH_ANCESTOR_SYMLINK') {
            return err(
              failure(
                'PATH_TARGET_SYMLINK',
                path,
                null,
                `"${path}" is a symlink; wrkrs does not read through symlinks`,
              ),
            )
          }
          if (error.code === 'PATH_ANCESTOR_NOT_A_DIRECTORY') {
            return err(failure('PATH_NOT_A_DIRECTORY', path, null, `"${path}" is not a directory`))
          }
        }
        const mapped = fromContainmentError(error, path)
        return mapped.ok ? ok(null) : mapped
      }
      throw error
    }
  }

  return { root, realRoot, resolve, readBytes, readText, listDirectory }
}
