import * as nodePath from 'node:path'

import type { FileSystemPort } from '../core/ports.js'
import { err, ok, type Result } from '../core/result.js'
import type { GitErrorCode, GitPort } from '../platform/git.js'

export type LocateErrorCode = GitErrorCode | 'CWD_NOT_FOUND' | 'CWD_NOT_A_DIRECTORY'

export interface LocateError {
  readonly code: LocateErrorCode
  readonly message: string
}

export interface LocatedRepository {
  /** Real (symlink-resolved) absolute worktree root. */
  readonly root: string
  /** Real absolute path of the requested working directory. */
  readonly cwd: string
  readonly dirty: boolean
}

/**
 * Resolves the Git worktree root for a working directory. Git is authoritative:
 * bare repositories and directories outside a worktree are rejected here,
 * before anything is read or planned.
 */
export async function locateRepository(
  requestedCwd: string,
  ports: { fs: FileSystemPort; git: GitPort },
): Promise<Result<LocatedRepository, LocateError>> {
  const absolute = nodePath.resolve(requestedCwd)
  const real = await ports.fs.realpath(absolute)
  if (real === null) {
    return err({ code: 'CWD_NOT_FOUND', message: `Directory not found: ${absolute}` })
  }
  const stat = await ports.fs.lstat(real)
  if (!stat || stat.kind !== 'directory') {
    return err({ code: 'CWD_NOT_A_DIRECTORY', message: `Not a directory: ${absolute}` })
  }
  const worktree = await ports.git.resolveWorktree(real)
  if (!worktree.ok) {
    return err(worktree.error)
  }
  const root = (await ports.fs.realpath(worktree.value.root)) ?? worktree.value.root
  return ok({ root, cwd: real, dirty: worktree.value.dirty })
}
