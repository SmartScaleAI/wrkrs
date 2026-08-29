import type { TransactionJournal } from '../core/ownership.js'
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
  readonly retained: readonly RetainedPath[]
}

function describe(error: unknown): string {
  if (error instanceof FileSystemError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/**
 * Reverses completed operations in reverse order. A file is deleted only when
 * its current hash still equals the hash wrkrs applied; anything else is
 * retained and reported so an external edit is never destroyed.
 */
export async function rollbackTransaction(input: {
  root: string
  fs: FileSystemPort
  journal: TransactionJournal
  persist: (journal: TransactionJournal) => Promise<TransactionJournal>
}): Promise<RollbackOutcome> {
  const { root, fs } = input
  let journal = input.journal
  const retained: RetainedPath[] = []

  const save = async (next: TransactionJournal): Promise<void> => {
    journal = next
    try {
      journal = await input.persist(journal)
    } catch {
      // Journal persistence is best effort during rollback; the in-memory state drives the outcome.
    }
  }

  const operations = [...journal.operations].reverse()
  for (const operation of operations) {
    if (operation.status !== 'applied' && operation.status !== 'staged') continue

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
            ? 'directory is not empty; it contains files wrkrs did not create or could not remove'
            : describe(error)
        retained.push({ path: operation.path, reason })
        await save(withOperation(journal, operation.path, { status: 'retained', note: reason }))
      }
      continue
    }

    if (operation.status === 'staged' && operation.stagingPath) {
      const stagingSystemPath = toSystemPath(root, operation.stagingPath)
      try {
        const stat = await fs.lstat(stagingSystemPath)
        if (stat) await fs.unlink(stagingSystemPath)
        await save(
          withOperation(journal, operation.path, {
            status: 'reverted',
            note: 'staged file removed',
          }),
        )
      } catch (error) {
        const reason = describe(error)
        retained.push({ path: operation.stagingPath, reason })
        await save(withOperation(journal, operation.path, { status: 'retained', note: reason }))
      }
      continue
    }

    const systemPath = toSystemPath(root, operation.path)
    try {
      const stat = await fs.lstat(systemPath)
      if (!stat) {
        await save(
          withOperation(journal, operation.path, { status: 'reverted', note: 'already absent' }),
        )
        continue
      }
      if (stat.kind !== 'file') {
        const reason = `path is now a ${stat.kind}; not removed`
        retained.push({ path: operation.path, reason })
        await save(withOperation(journal, operation.path, { status: 'retained', note: reason }))
        continue
      }
      const currentHash = sha256(await fs.readFile(systemPath))
      if (currentHash !== operation.appliedHash) {
        const reason = 'file was modified after wrkrs wrote it; the external change is preserved'
        retained.push({ path: operation.path, reason })
        await save(withOperation(journal, operation.path, { status: 'retained', note: reason }))
        continue
      }
      await fs.unlink(systemPath)
      await save(
        withOperation(journal, operation.path, { status: 'reverted', note: 'file removed' }),
      )
    } catch (error) {
      const reason = describe(error)
      retained.push({ path: operation.path, reason })
      await save(withOperation(journal, operation.path, { status: 'retained', note: reason }))
    }
  }

  return { journal, retained }
}
