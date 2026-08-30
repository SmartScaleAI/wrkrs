import type { DirectoryEntry, FileStat, FileSystemPort } from '../core/ports.js'
import { err, ok, type Result } from '../core/result.js'
import { ancestorDirectories, isWithinRoot, normalizeRelativePath, toSystemPath } from './paths.js'

export type ContainmentFailureCode =
  | 'PATH_INVALID'
  | 'PATH_ANCESTOR_SYMLINK'
  | 'PATH_ANCESTOR_NOT_A_DIRECTORY'
  | 'PATH_ESCAPES_ROOT'
  | 'PATH_TARGET_SYMLINK'
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
 * Safe read boundary for the selected worktree. Every access normalizes the
 * relative path, inspects each ancestor with lstat, refuses to follow a
 * symlinked ancestor, and proves the real ancestor stays inside the real
 * repository root before any read. The scanner, `wrkrs check`, and adapter
 * validation share this boundary so nothing is read through `.claude`,
 * `.wrkrs`, a role source, or any other symlinked path.
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

export async function createRepositoryReader(
  root: string,
  fs: FileSystemPort,
): Promise<RepositoryReader> {
  const realRoot = (await fs.realpath(root)) ?? root
  const decoder = new TextDecoder('utf-8', { fatal: false })
  /** Ancestors already proven to be real directories inside the root during this reader's life. */
  const verifiedDirectories = new Set<string>()

  async function resolve(relativePath: string): Promise<Result<ResolvedPath, ContainmentFailure>> {
    if (relativePath === '') {
      return ok({ relativePath: '', systemPath: root, stat: await fs.lstat(root) })
    }
    const normalized = normalizeRelativePath(relativePath)
    if (!normalized.ok) {
      return err(failure('PATH_INVALID', relativePath, null, normalized.error.message))
    }
    const path = normalized.value
    for (const ancestor of ancestorDirectories(path)) {
      if (verifiedDirectories.has(ancestor)) continue
      const ancestorSystemPath = toSystemPath(root, ancestor)
      const stat = await fs.lstat(ancestorSystemPath)
      if (!stat) {
        return ok({ relativePath: path, systemPath: toSystemPath(root, path), stat: null })
      }
      if (stat.kind === 'symlink') {
        return err(
          failure(
            'PATH_ANCESTOR_SYMLINK',
            path,
            ancestor,
            `"${ancestor}" is a symlink; wrkrs does not read through symlinked directories`,
          ),
        )
      }
      if (stat.kind !== 'directory') {
        return err(
          failure(
            'PATH_ANCESTOR_NOT_A_DIRECTORY',
            path,
            ancestor,
            `"${ancestor}" is a ${stat.kind}, not a directory`,
          ),
        )
      }
      const real = await fs.realpath(ancestorSystemPath)
      if (real === null || !isWithinRoot(realRoot, real)) {
        return err(
          failure(
            'PATH_ESCAPES_ROOT',
            path,
            ancestor,
            `"${ancestor}" resolves outside the repository root`,
          ),
        )
      }
      verifiedDirectories.add(ancestor)
    }
    const systemPath = toSystemPath(root, path)
    return ok({ relativePath: path, systemPath, stat: await fs.lstat(systemPath) })
  }

  async function readBytes(
    relativePath: string,
    maxBytes = DEFAULT_MAX_READ_BYTES,
  ): Promise<Result<Uint8Array | null, ContainmentFailure>> {
    const resolved = await resolve(relativePath)
    if (!resolved.ok) return resolved
    const { stat, systemPath, relativePath: path } = resolved.value
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
    return ok(await fs.readFile(systemPath))
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
    const resolved = await resolve(relativePath)
    if (!resolved.ok) return resolved
    const { stat, systemPath, relativePath: path } = resolved.value
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
    if (stat.kind !== 'directory') {
      return err(
        failure('PATH_NOT_A_DIRECTORY', path, null, `"${path}" is a ${stat.kind}, not a directory`),
      )
    }
    return ok(await fs.readDirectory(systemPath))
  }

  return { root, realRoot, resolve, readBytes, readText, listDirectory }
}
