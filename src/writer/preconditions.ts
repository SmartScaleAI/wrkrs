import type { Conflict, InstallPlan } from '../core/plan.js'
import type { FileSystemPort } from '../core/ports.js'
import { createRepositoryReader } from '../platform/contained-path.js'
import { sha256 } from '../platform/hash.js'
import { ancestorDirectories } from '../platform/paths.js'
import { conflict } from '../planner/conflicts.js'

const REPLAN =
  'The repository changed after planning; run the same command with --dry-run again and review the new plan'

/**
 * Re-reads every operation target immediately before (and again after) the
 * installation lock is taken, through the contained reader so a symlinked
 * ancestor is never followed. Any difference from the planned expectation is
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
  const created = new Set(plan.createdDirectories)
  const checkedDirectories = new Set<string>()
  const reader = await createRepositoryReader(root, fs)

  const checkAncestor = async (ancestor: string, path: string): Promise<void> => {
    if (checkedDirectories.has(ancestor)) return
    checkedDirectories.add(ancestor)
    const resolved = await reader.resolve(ancestor)
    if (!resolved.ok) {
      conflicts.push(
        conflict(
          'PATH',
          resolved.error.code === 'PATH_ANCESTOR_SYMLINK'
            ? 'PATH_ANCESTOR_SYMLINK'
            : 'PATH_ANCESTOR_CHANGED',
          ancestor,
          `${resolved.error.message}; nothing was written`,
          REPLAN,
        ),
      )
      return
    }
    const stat = resolved.value.stat
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
          stat.kind === 'symlink' ? 'PATH' : 'PRECONDITION',
          stat.kind === 'symlink' ? 'PATH_ANCESTOR_SYMLINK' : 'PRECONDITION_ANCESTOR_CHANGED',
          ancestor,
          `"${ancestor}" is now a ${stat.kind}`,
          REPLAN,
        ),
      )
    }
  }

  for (const operation of plan.operations) {
    if (operation.outcome === 'create') {
      for (const ancestor of ancestorDirectories(operation.path)) {
        await checkAncestor(ancestor, operation.path)
      }
      const resolved = await reader.resolve(operation.path)
      if (!resolved.ok) {
        if (!checkedDirectories.has(resolved.error.ancestor ?? '')) {
          conflicts.push(
            conflict(
              'PATH',
              'PATH_ANCESTOR_CHANGED',
              operation.path,
              `${resolved.error.message}; nothing was written`,
              REPLAN,
            ),
          )
        }
        continue
      }
      if (resolved.value.stat) {
        conflicts.push(
          conflict(
            'PRECONDITION',
            'PRECONDITION_TARGET_CHANGED',
            operation.path,
            `"${operation.path}" appeared after planning (${resolved.value.stat.kind})`,
            REPLAN,
          ),
        )
      }
    } else if (operation.outcome === 'replace' || operation.outcome === 'remove') {
      // A file wrkrs owns may only be replaced or removed while it still holds
      // the exact bytes planning saw. Its ancestors must already exist: these
      // operations never create a directory.
      for (const ancestor of ancestorDirectories(operation.path)) {
        await checkAncestor(ancestor, operation.path)
      }
      const expected = operation.expected
      if (expected.kind !== 'file') {
        conflicts.push(
          conflict(
            'PRECONDITION',
            'PRECONDITION_TARGET_CHANGED',
            operation.path,
            `"${operation.path}" was not planned from a regular file`,
            REPLAN,
          ),
        )
        continue
      }
      const resolved = await reader.resolve(operation.path)
      if (!resolved.ok) {
        conflicts.push(
          conflict(
            'PATH',
            'PATH_ANCESTOR_CHANGED',
            operation.path,
            `${resolved.error.message}; nothing was written`,
            REPLAN,
          ),
        )
        continue
      }
      const stat = resolved.value.stat
      if (!stat || stat.kind !== 'file') {
        conflicts.push(
          conflict(
            'PRECONDITION',
            'PRECONDITION_TARGET_CHANGED',
            operation.path,
            stat
              ? `"${operation.path}" is now a ${stat.kind}, not the regular file that was planned`
              : `"${operation.path}" no longer exists`,
            REPLAN,
          ),
        )
        continue
      }
      const bytes = await reader.readBytes(operation.path)
      if (!bytes.ok || bytes.value === null || sha256(bytes.value) !== expected.hash) {
        conflicts.push(
          conflict(
            'PRECONDITION',
            'PRECONDITION_TARGET_CHANGED',
            operation.path,
            `"${operation.path}" changed after planning; wrkrs never ${operation.outcome === 'remove' ? 'removes' : 'overwrites'} content it did not plan against`,
            REPLAN,
          ),
        )
      }
    } else if (operation.outcome === 'reuse' || operation.outcome === 'no-op') {
      const expectedHash = operation.expected.kind === 'file' ? operation.expected.hash : null
      const bytes = await reader.readBytes(operation.path)
      if (!bytes.ok || bytes.value === null || expectedHash === null) {
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
      if (sha256(bytes.value) !== expectedHash) {
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
