import type { TransactionJournal } from '../core/ownership.js'
import { ContainmentError, FileSystemError, type FileSystemPort } from '../core/ports.js'
import { sha256 } from '../platform/hash.js'
import { baseName, parentDirectory } from '../platform/paths.js'
import { withOperation } from './journal.js'

export interface RetainedPath {
  readonly path: string
  readonly reason: string
}

export interface RollbackOutcome {
  readonly journal: TransactionJournal
  /** Every exact path that still exists (or cannot be proven absent) after rollback. */
  readonly retained: readonly RetainedPath[]
}

function describe(error: unknown): string {
  if (error instanceof ContainmentError) return `${error.code}: ${error.message}; not touched`
  if (error instanceof FileSystemError) return `${error.code} while removing the path`
  return error instanceof Error ? error.name : String(error)
}

/** A missing ancestor proves the path itself is absent. */
function ancestorMissing(error: unknown): boolean {
  return error instanceof ContainmentError && error.code === 'PATH_ANCESTOR_MISSING'
}

/**
 * Reverses completed operations in reverse order and then verifies the
 * result. Every removal is performed inside the bound parent directory, so a
 * changed ancestor makes the removal fail closed instead of reaching outside
 * the repository. A file is deleted only when its current hash still equals
 * the hash wrkrs recorded before publication; anything else (external
 * content, a later modification, a non-regular file, an unbindable parent)
 * is retained and reported by exact path.
 *
 * The in-memory journal is authoritative: it records publication before any
 * attempt to persist that fact, and keeps the staging path until staging
 * cleanup is verified, so neither a journal write failure nor a cleanup
 * failure can hide a name wrkrs created.
 */
export async function rollbackTransaction(input: {
  root: string
  fs: FileSystemPort
  journal: TransactionJournal
  persist: (journal: TransactionJournal) => Promise<TransactionJournal>
}): Promise<RollbackOutcome> {
  const { root, fs } = input
  let journal = input.journal
  const retained = new Map<string, string>()
  const touchedDirectories = new Set<string>()

  const retain = (path: string, reason: string): void => {
    if (!retained.has(path)) retained.set(path, reason)
  }

  const save = async (next: TransactionJournal): Promise<void> => {
    journal = next
    try {
      journal = await input.persist(journal)
    } catch {
      // Journal persistence is best effort during rollback; the in-memory
      // state and the final verification pass decide the outcome.
    }
  }

  /** Deletes a regular file only when its content hash proves wrkrs wrote it unchanged. */
  const removeIfOurs = async (
    relativePath: string,
    expectedHash: string | null,
    what: string,
  ): Promise<'removed' | 'absent' | 'retained'> => {
    const directory = parentDirectory(relativePath) ?? ''
    const name = baseName(relativePath)
    try {
      return await fs.withinDirectory(root, directory, async (bound) => {
        const stat = await bound.lstat(name)
        if (!stat) return 'absent'
        if (stat.kind !== 'file') {
          retain(relativePath, `${what} is now a ${stat.kind}; not removed`)
          return 'retained'
        }
        if (expectedHash === null) {
          retain(relativePath, `${what} has no recorded hash; not removed`)
          return 'retained'
        }
        const currentHash = sha256(await bound.readFile(name))
        if (currentHash !== expectedHash) {
          retain(
            relativePath,
            `${what} differs from what wrkrs wrote; the external change is preserved`,
          )
          return 'retained'
        }
        await bound.unlink(name)
        touchedDirectories.add(directory)
        return 'removed'
      })
    } catch (error) {
      if (ancestorMissing(error)) return 'absent'
      retain(relativePath, describe(error))
      return 'retained'
    }
  }

  const operations = [...journal.operations].reverse()
  for (const operation of operations) {
    if (operation.status === 'planned') continue
    if (operation.status === 'reverted' || operation.status === 'retained') continue

    if (operation.kind === 'create-directory') {
      const directory = parentDirectory(operation.path) ?? ''
      const name = baseName(operation.path)
      try {
        await fs.withinDirectory(root, directory, (bound) => bound.removeDirectory(name))
        touchedDirectories.add(directory)
        await save(
          withOperation(journal, operation.path, { status: 'reverted', note: 'directory removed' }),
        )
      } catch (error) {
        if (
          (error instanceof FileSystemError && error.code === 'ENOENT') ||
          ancestorMissing(error)
        ) {
          await save(
            withOperation(journal, operation.path, { status: 'reverted', note: 'already absent' }),
          )
          continue
        }
        const reason =
          error instanceof FileSystemError && error.code === 'ENOTEMPTY'
            ? 'directory is not empty; it contains entries wrkrs did not create or could not remove'
            : describe(error)
        retain(operation.path, reason)
        await save(withOperation(journal, operation.path, { status: 'retained', note: reason }))
      }
      continue
    }

    let clean = true
    if (operation.stagingPath) {
      const result = await removeIfOurs(
        operation.stagingPath,
        operation.expectedHash,
        'staging file',
      )
      if (result === 'retained') clean = false
    }
    if (operation.status === 'published' || operation.status === 'applied') {
      const result = await removeIfOurs(operation.path, operation.expectedHash, 'file')
      if (result === 'retained') clean = false
    }
    // A 'staged' operation never published its target (publication failed or
    // was never attempted), so the target path is deliberately left alone.
    const reason =
      retained.get(operation.path) ?? retained.get(operation.stagingPath ?? '') ?? 'retained'
    await save(
      withOperation(journal, operation.path, {
        status: clean ? 'reverted' : 'retained',
        note: clean ? (operation.note ?? 'restored') : reason,
      }),
    )
  }

  // Best-effort durability for the removals themselves.
  for (const directory of touchedDirectories) {
    try {
      await fs.withinDirectory(root, directory, (bound) => bound.sync())
    } catch {
      // A failed sync cannot make a removed entry reappear; verification below is authoritative.
    }
  }

  // Verification pass: every path this transaction may have created must be
  // proven absent, whatever the loop above believed. A path that cannot be
  // inspected inside its bound parent is retained (fail closed).
  for (const operation of input.journal.operations) {
    if (operation.status === 'planned') continue
    const paths: string[] = []
    if (operation.stagingPath) paths.push(operation.stagingPath)
    if (
      operation.kind === 'create-directory' ||
      operation.status === 'published' ||
      operation.status === 'applied'
    ) {
      paths.push(operation.path)
    }
    for (const path of paths) {
      if (retained.has(path)) continue
      const directory = parentDirectory(path) ?? ''
      const name = baseName(path)
      try {
        const stat = await fs.withinDirectory(root, directory, (bound) => bound.lstat(name))
        if (stat) retain(path, `${stat.kind} still present after rollback`)
      } catch (error) {
        if (ancestorMissing(error)) continue
        retain(path, `could not verify removal (${describe(error)})`)
      }
    }
  }

  return {
    journal,
    retained: [...retained.entries()]
      .map(([path, reason]) => ({ path, reason }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  }
}
