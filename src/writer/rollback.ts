import type { JournalOperation, TransactionJournal } from '../core/ownership.js'
import { FileSystemError, type FileSystemPort } from '../core/ports.js'
import { sha256 } from '../platform/hash.js'
import { toSystemPath } from '../platform/paths.js'
import { withOperation } from './journal.js'

export interface RetainedPath {
  readonly path: string
  readonly reason: string
}

export interface RollbackOutcome {
  readonly journal: TransactionJournal
  /** Every exact path that still exists and could not be proven safe to remove. */
  readonly retained: readonly RetainedPath[]
}

function describe(error: unknown): string {
  if (error instanceof FileSystemError) return `${error.code} while removing the path`
  return error instanceof Error ? error.name : String(error)
}

/**
 * Reverses completed operations in reverse order and then verifies the
 * result. A file is deleted only when its current hash still equals the hash
 * wrkrs recorded before publication; anything else (external content, a
 * later modification, a non-regular file) is retained and reported by exact
 * path so a rollback can never destroy work wrkrs did not create.
 *
 * The in-memory journal is authoritative: it records publication before any
 * attempt to persist that fact, so a journal write failure cannot make a
 * published target invisible to reconciliation.
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
    const systemPath = toSystemPath(root, relativePath)
    try {
      const stat = await fs.lstat(systemPath)
      if (!stat) return 'absent'
      if (stat.kind !== 'file') {
        retain(relativePath, `${what} is now a ${stat.kind}; not removed`)
        return 'retained'
      }
      if (expectedHash === null) {
        retain(relativePath, `${what} has no recorded hash; not removed`)
        return 'retained'
      }
      const currentHash = sha256(await fs.readFile(systemPath))
      if (currentHash !== expectedHash) {
        retain(
          relativePath,
          `${what} differs from what wrkrs wrote; the external change is preserved`,
        )
        return 'retained'
      }
      await fs.unlink(systemPath)
      return 'removed'
    } catch (error) {
      retain(relativePath, describe(error))
      return 'retained'
    }
  }

  const operations = [...journal.operations].reverse()
  for (const operation of operations) {
    if (operation.status === 'planned') continue
    if (operation.status === 'reverted' || operation.status === 'retained') continue

    if (operation.kind === 'create-directory') {
      const systemPath = toSystemPath(root, operation.path)
      try {
        await fs.removeDirectory(systemPath)
        await save(
          withOperation(journal, operation.path, { status: 'reverted', note: 'directory removed' }),
        )
      } catch (error) {
        if (error instanceof FileSystemError && error.code === 'ENOENT') {
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

  // Verification pass: every path this transaction may have created must be
  // gone, whatever the loop above believed.
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
      const stat = await fs.lstat(toSystemPath(root, path)).catch(() => null)
      if (stat) retain(path, `${stat.kind} still present after rollback`)
    }
  }

  return {
    journal,
    retained: [...retained.entries()]
      .map(([path, reason]) => ({ path, reason }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  }
}

export function operationReachedDisk(operation: JournalOperation): boolean {
  return operation.status !== 'planned'
}
