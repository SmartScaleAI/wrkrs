import type { TransactionJournal } from '../core/ownership.js'
import { ContainmentError, FileSystemError, type FileSystemPort } from '../core/ports.js'
import { sha256 } from '../platform/hash.js'
import { baseName, parentDirectory } from '../platform/paths.js'
import { withDurability, withOperation } from './journal.js'

export interface RetainedPath {
  readonly path: string
  readonly reason: string
}

export interface RollbackOutcome {
  /** Journal with every operation reconciled and durability downgrades applied. */
  readonly journal: TransactionJournal
  /** Every exact path that still exists, cannot be proven absent, or whose removal is not proven durable. */
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

function isPrefix(candidate: Uint8Array, full: Uint8Array): boolean {
  if (candidate.byteLength > full.byteLength) return false
  for (let index = 0; index < candidate.byteLength; index += 1) {
    if (candidate[index] !== full[index]) return false
  }
  return true
}

const DURABILITY_UNPROVEN =
  'removed, but the directory sync failed so the removal is not proven durable'

/**
 * Reverses completed operations in reverse order and then verifies the
 * result. Every removal is performed inside the bound parent directory and
 * follows one order: remove the name, verify it is absent, sync the
 * containing directory, and only then record the operation as reverted. A
 * real sync failure is never swallowed: the path is retained as "durability
 * unproven" and the transaction reports rollback-incomplete.
 *
 * A file is deleted only when it is proven to be wrkrs's: its hash equals the
 * recorded expected hash, or, for a staging entry whose exclusive write
 * failed after creation, its bytes are a prefix of the planned bytes (a
 * partial write of wrkrs's own data). Anything else — external content, a
 * later modification, a non-regular file, an unbindable parent — is retained
 * and reported by exact path.
 *
 * The in-memory journal is authoritative: it records a staging name before
 * the exclusive write, publication before any fallible step, and keeps the
 * staging path until its removal is proven, so no failure can hide a name
 * wrkrs created.
 */
export async function rollbackTransaction(input: {
  root: string
  fs: FileSystemPort
  journal: TransactionJournal
  persist: (journal: TransactionJournal) => Promise<TransactionJournal>
  /** Planned bytes for a target path, used to recognize wrkrs's own partial staging writes. */
  expectedBytes: (targetPath: string) => Uint8Array | null
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

  /**
   * Deletes a regular file only when it is proven to be wrkrs's, then proves
   * the removal (absence check, directory sync) before reporting 'removed'.
   */
  const removeIfOurs = async (
    relativePath: string,
    expectedHash: string | null,
    what: string,
    partialOf: Uint8Array | null,
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
        const bytes = await bound.readFile(name)
        const currentHash = sha256(bytes)
        const complete = expectedHash !== null && currentHash === expectedHash
        const partial = partialOf !== null && isPrefix(bytes, partialOf)
        if (!complete && !partial) {
          retain(
            relativePath,
            `${what} differs from what wrkrs wrote; the external change is preserved`,
          )
          return 'retained'
        }
        await bound.unlink(name)
        if (await bound.lstat(name)) {
          retain(relativePath, `${what} is still present after removal`)
          return 'retained'
        }
        let sync
        try {
          sync = await bound.sync()
        } catch {
          retain(relativePath, DURABILITY_UNPROVEN)
          return 'retained'
        }
        journal = withDurability(journal, sync)
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
      let outcome: 'reverted' | 'retained' = 'reverted'
      let note = 'directory removed'
      try {
        await fs.withinDirectory(root, directory, async (bound) => {
          try {
            await bound.removeDirectory(name)
          } catch (error) {
            if (!(error instanceof FileSystemError && error.code === 'ENOENT')) throw error
            note = 'already absent'
          }
          if (await bound.lstat(name)) {
            throw new FileSystemError('EEXIST', name, 'still present after removal')
          }
          let sync
          try {
            sync = await bound.sync()
          } catch {
            outcome = 'retained'
            note = DURABILITY_UNPROVEN
            retain(operation.path, DURABILITY_UNPROVEN)
            return
          }
          journal = withDurability(journal, sync)
        })
      } catch (error) {
        if (ancestorMissing(error)) {
          note = 'already absent'
        } else {
          outcome = 'retained'
          note =
            error instanceof FileSystemError && error.code === 'ENOTEMPTY'
              ? 'directory is not empty; it contains entries wrkrs did not create or could not remove'
              : describe(error)
          retain(operation.path, note)
        }
      }
      await save(withOperation(journal, operation.path, { status: outcome, note }))
      continue
    }

    let clean = true
    if (operation.stagingPath) {
      const partialOf = operation.status === 'staging' ? input.expectedBytes(operation.path) : null
      const result = await removeIfOurs(
        operation.stagingPath,
        operation.expectedHash,
        'staging file',
        partialOf,
      )
      if (result === 'retained') clean = false
    }
    if (operation.status === 'published' || operation.status === 'applied') {
      const result = await removeIfOurs(operation.path, operation.expectedHash, 'file', null)
      if (result === 'retained') clean = false
    }
    // A 'staging' or 'staged' operation never published its target
    // (publication failed or was never attempted), so the target path is
    // deliberately left alone.
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
