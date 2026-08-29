import type { ProcessPort } from '../core/ports.js'
import { err, ok, type Result } from '../core/result.js'

export type GitErrorCode =
  | 'GIT_NOT_FOUND'
  | 'GIT_NOT_A_REPOSITORY'
  | 'GIT_BARE_REPOSITORY'
  | 'GIT_NOT_IN_WORKTREE'
  | 'GIT_COMMAND_FAILED'

export interface GitError {
  readonly code: GitErrorCode
  readonly message: string
}

export interface GitWorktree {
  /** Absolute worktree root as reported by git. */
  readonly root: string
  readonly dirty: boolean
}

export interface GitPort {
  version(): Promise<Result<string, GitError>>
  resolveWorktree(cwd: string): Promise<Result<GitWorktree, GitError>>
}

export function createGit(processPort: ProcessPort, executable = 'git'): GitPort {
  async function run(args: readonly string[], cwd: string) {
    return processPort.run(executable, args, { cwd })
  }

  return {
    async version() {
      const result = await processPort.run(executable, ['--version'])
      if (!result.started) {
        return err({
          code: 'GIT_NOT_FOUND',
          message: `Git executable "${executable}" was not found (${result.errorCode ?? 'unknown error'})`,
        })
      }
      if (result.exitCode !== 0) {
        return err({
          code: 'GIT_COMMAND_FAILED',
          message: result.stderr.trim() || 'git --version failed',
        })
      }
      return ok(result.stdout.trim())
    },

    async resolveWorktree(cwd) {
      const bare = await run(['rev-parse', '--is-bare-repository'], cwd)
      if (!bare.started) {
        return err({
          code: 'GIT_NOT_FOUND',
          message: `Git executable "${executable}" was not found (${bare.errorCode ?? 'unknown error'})`,
        })
      }
      if (bare.exitCode !== 0) {
        const detail = bare.stderr.trim()
        if (/not a git repository/i.test(detail)) {
          return err({
            code: 'GIT_NOT_A_REPOSITORY',
            message: `${cwd} is not inside a Git repository`,
          })
        }
        return err({ code: 'GIT_COMMAND_FAILED', message: detail || 'git rev-parse failed' })
      }
      if (bare.stdout.trim() === 'true') {
        return err({
          code: 'GIT_BARE_REPOSITORY',
          message: `${cwd} is inside a bare Git repository; wrkrs requires a worktree`,
        })
      }

      const inside = await run(['rev-parse', '--is-inside-work-tree'], cwd)
      if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
        return err({
          code: 'GIT_NOT_IN_WORKTREE',
          message: `${cwd} is not inside a Git worktree`,
        })
      }

      const top = await run(['rev-parse', '--show-toplevel'], cwd)
      if (top.exitCode !== 0 || top.stdout.trim() === '') {
        return err({
          code: 'GIT_COMMAND_FAILED',
          message: top.stderr.trim() || 'git rev-parse --show-toplevel failed',
        })
      }
      const root = top.stdout.trim()

      const status = await run(['status', '--porcelain'], cwd)
      const dirty = status.exitCode === 0 && status.stdout.trim().length > 0
      return ok({ root, dirty })
    },
  }
}
