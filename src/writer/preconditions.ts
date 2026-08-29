import type { Conflict, InstallPlan } from '../core/plan.js'
import type { FileSystemPort } from '../core/ports.js'
import { sha256 } from '../platform/hash.js'
import { ancestorDirectories, isWithinRoot, toSystemPath } from '../platform/paths.js'
import { conflict } from '../planner/conflicts.js'

const REPLAN =
  'The repository changed after planning; run `wrkrs init --dry-run` again and review the new plan'

/**
 * Re-reads every operation target immediately before (and again after) the
 * installation lock is taken. Any difference from the planned expectation is
 * reported as a PRECONDITION conflict and nothing is written.
 */
export async function recheckPreconditions(
  plan: InstallPlan,
  root: string,
  fs: FileSystemPort,
  options: { allowExistingDirectories?: ReadonlySet<string> } = {},
): Promise<Conflict[]> {
  const conflicts: Conflict[] = []
  const allowExisting = options.allowExistingDirectories ?? new Set<string>()
  const realRoot = (await fs.realpath(root)) ?? root
  const created = new Set(plan.createdDirectories)
  const checkedDirectories = new Set<string>()

  const checkAncestor = async (ancestor: string, path: string): Promise<void> => {
    if (checkedDirectories.has(ancestor)) return
    checkedDirectories.add(ancestor)
    const systemPath = toSystemPath(root, ancestor)
    const stat = await fs.lstat(systemPath)
    if (created.has(ancestor)) {
      if (stat && !allowExisting.has(ancestor)) {
        conflicts.push(
          conflict(
            'PRECONDITION',
            'PRECONDITION_DIRECTORY_APPEARED',
            ancestor,
            `Directory "${ancestor}" was expected to be absent`,
            REPLAN,
          ),
        )
      } else if (stat && stat.kind !== 'directory') {
        conflicts.push(
          conflict(
            'PRECONDITION',
            'PRECONDITION_ANCESTOR_CHANGED',
            ancestor,
            `"${ancestor}" is a ${stat.kind}, not a directory`,
            REPLAN,
          ),
        )
      }
      return
    }
    if (!stat) {
      conflicts.push(
        conflict(
          'PRECONDITION',
          'PRECONDITION_DIRECTORY_MISSING',
          ancestor,
          `Directory "${ancestor}" required by ${path} no longer exists`,
          REPLAN,
        ),
      )
      return
    }
    if (stat.kind !== 'directory') {
      conflicts.push(
        conflict(
          'PRECONDITION',
          'PRECONDITION_ANCESTOR_CHANGED',
          ancestor,
          `"${ancestor}" is now a ${stat.kind}`,
          REPLAN,
        ),
      )
      return
    }
    const real = await fs.realpath(systemPath)
    if (real === null || !isWithinRoot(realRoot, real)) {
      conflicts.push(
        conflict(
          'PATH',
          'PATH_ESCAPES_ROOT',
          ancestor,
          `"${ancestor}" resolves outside the repository root`,
          'Replace the symlinked directory with a real directory inside the repository',
        ),
      )
    }
  }

  for (const operation of plan.operations) {
    if (operation.outcome === 'create') {
      const stat = await fs.lstat(toSystemPath(root, operation.path))
      if (stat) {
        conflicts.push(
          conflict(
            'PRECONDITION',
            'PRECONDITION_TARGET_CHANGED',
            operation.path,
            `"${operation.path}" appeared after planning (${stat.kind})`,
            REPLAN,
          ),
        )
      }
      for (const ancestor of ancestorDirectories(operation.path)) {
        await checkAncestor(ancestor, operation.path)
      }
    } else if (operation.outcome === 'reuse' || operation.outcome === 'no-op') {
      const systemPath = toSystemPath(root, operation.path)
      const stat = await fs.lstat(systemPath)
      const expectedHash = operation.expected.kind === 'file' ? operation.expected.hash : null
      if (!stat || stat.kind !== 'file' || expectedHash === null) {
        conflicts.push(
          conflict(
            'PRECONDITION',
            'PRECONDITION_TARGET_CHANGED',
            operation.path,
            `"${operation.path}" is no longer the regular file that was planned for reuse`,
            REPLAN,
          ),
        )
        continue
      }
      const hash = sha256(await fs.readFile(systemPath))
      if (hash !== expectedHash) {
        conflicts.push(
          conflict(
            'PRECONDITION',
            'PRECONDITION_TARGET_CHANGED',
            operation.path,
            `"${operation.path}" changed after planning`,
            REPLAN,
          ),
        )
      }
    }
  }
  return conflicts
}
