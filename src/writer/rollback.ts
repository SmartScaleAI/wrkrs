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
 * A file is deleted only when it is proven to be wrkrs's: its current hash
 * equals the recorded expected hash of the fully written content. An
 * incomplete staging entry from a failed exclusive write is never deleted,
 * because no portable primitive can prove the current directory entry is
 * still the one wrkrs created; it is retained and reported by exact path.
 * Anything else — external content, a later modification, a non-regular
 * file, an unbindable parent — is likewise retained and reported.
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
        if (expectedHash === null || currentHash !== expectedHash) {
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

  /**
   * An incomplete staging entry (its exclusive write failed after creation)
   * is never deleted: Node has no identity-conditional unlink, so wrkrs
   * cannot prove the current entry is still the file it created rather than
   * an external replacement. It is retained and reported by exact path.
   */
  const retainIncompleteStaging = async (relativePath: string): Promise<'absent' | 'retained'> => {
    const directory = parentDirectory(relativePath) ?? ''
    const name = baseName(relativePath)
    try {
      const stat = await fs.withinDirectory(root, directory, (bound) => bound.lstat(name))
      if (!stat) return 'absent'
      retain(
        relativePath,
        'incomplete staging entry from a failed exclusive write; wrkrs cannot prove the current entry is still the file it created, so it is preserved',
      )
      return 'retained'
    } catch (error) {
      if (ancestorMissing(error)) return 'absent'
      retain(relativePath, describe(error))
      return 'retained'
    }
  }

  /**
   * Restores a replaced or removed file from its sibling backup, which holds
   * the original inode. The restore happens only when wrkrs can still prove
   * both sides: the backup must hash to the content it recorded, and the
   * target must be exactly what wrkrs left there (or absent, for a removal).
   * Anything else is an external change and is preserved untouched.
   */
  const restoreFromBackup = async (input: {
    targetPath: string
    backupPath: string
    backupHash: string | null
    /** Hash wrkrs wrote at the target, or null when the target should be absent. */
    wroteHash: string | null
    what: string
  }): Promise<'restored' | 'retained'> => {
    const directory = parentDirectory(input.targetPath) ?? ''
    const targetName = baseName(input.targetPath)
    const backupName = baseName(input.backupPath)
    try {
      return await fs.withinDirectory(root, directory, async (bound) => {
        const backupStat = await bound.lstat(backupName)
        const targetStat = await bound.lstat(targetName)

        if (!backupStat || backupStat.kind !== 'file') {
          // Without the backup nothing can be proven. The target is left as it
          // is; it is only clean when it already holds the original content.
          if (targetStat && targetStat.kind === 'file' && input.backupHash) {
            const current = sha256(await bound.readFile(targetName))
            if (current === input.backupHash) return 'restored'
          }
          retain(
            input.targetPath,
            `${input.what} could not be restored: the backup wrkrs made is gone`,
          )
          return 'retained'
        }

        const backupContent = sha256(await bound.readFile(backupName))
        if (input.backupHash === null || backupContent !== input.backupHash) {
          retain(
            input.backupPath,
            'backup entry differs from what wrkrs linked; it is preserved and the target is untouched',
          )
          return 'retained'
        }

        if (targetStat) {
          if (targetStat.kind !== 'file') {
            retain(input.targetPath, `${input.what} is now a ${targetStat.kind}; not restored`)
            retain(input.backupPath, 'backup of the original content, kept for recovery')
            return 'retained'
          }
          const current = sha256(await bound.readFile(targetName))
          if (current === input.backupHash) {
            // Already the original content: only the backup link is redundant.
            await bound.unlink(backupName)
            journal = withDurability(journal, await bound.sync())
            return 'restored'
          }
          if (input.wroteHash === null || current !== input.wroteHash) {
            retain(
              input.targetPath,
              `${input.what} differs from what wrkrs wrote; the external change is preserved`,
            )
            retain(input.backupPath, 'backup of the original content, kept for recovery')
            return 'retained'
          }
        } else if (input.wroteHash !== null) {
          // wrkrs wrote content here and it has since disappeared.
          retain(
            input.targetPath,
            `${input.what} disappeared after wrkrs wrote it; the backup is kept for recovery`,
          )
          retain(input.backupPath, 'backup of the original content, kept for recovery')
          return 'retained'
        }

        await bound.rename(backupName, targetName)
        const restored = sha256(await bound.readFile(targetName))
        if (restored !== input.backupHash) {
          retain(input.targetPath, `${input.what} was restored but does not match the original`)
          return 'retained'
        }
        try {
          journal = withDurability(journal, await bound.sync())
        } catch {
          retain(input.targetPath, `${input.what} was restored, but the directory sync failed`)
          return 'retained'
        }
        return 'restored'
      })
    } catch (error) {
      if (ancestorMissing(error)) {
        retain(input.targetPath, `${input.what} could not be reached; nothing was restored`)
        return 'retained'
      }
      retain(input.targetPath, describe(error))
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

    if (operation.kind === 'remove-directory') {
      // Directory removals run only after the transaction commits, so a
      // rollback never has one to reverse.
      await save(
        withOperation(journal, operation.path, {
          status: 'reverted',
          note: 'directory removal never ran',
        }),
      )
      continue
    }

    if (operation.kind === 'replace-file' || operation.kind === 'remove-file') {
      let clean = true
      // A staging entry only exists for a replacement whose rename never ran.
      if (operation.stagingPath) {
        const result =
          operation.status === 'staging'
            ? await retainIncompleteStaging(operation.stagingPath)
            : await removeIfOurs(operation.stagingPath, operation.expectedHash, 'staging file')
        if (result === 'retained') clean = false
      }
      if (operation.backupPath) {
        const wrote =
          operation.kind === 'replace-file' &&
          (operation.status === 'published' || operation.status === 'applied')
            ? (operation.appliedHash ?? operation.expectedHash)
            : null
        const removed = operation.kind === 'remove-file' && operation.status === 'removed'
        if (wrote !== null || removed) {
          const result = await restoreFromBackup({
            targetPath: operation.path,
            backupPath: operation.backupPath,
            backupHash: operation.backupHash,
            wroteHash: wrote,
            what: operation.kind === 'remove-file' ? 'removed file' : 'replaced file',
          })
          if (result === 'retained') clean = false
        } else {
          // The target was never changed; only the redundant backup link goes.
          const result = await removeIfOurs(
            operation.backupPath,
            operation.backupHash,
            'backup file',
          )
          if (result === 'retained') clean = false
        }
      }
      const reason =
        retained.get(operation.path) ?? retained.get(operation.backupPath ?? '') ?? 'retained'
      await save(
        withOperation(journal, operation.path, {
          status: clean ? 'reverted' : 'retained',
          note: clean ? 'original content restored' : reason,
        }),
      )
      continue
    }

    let clean = true
    if (operation.stagingPath) {
      const result =
        operation.status === 'staging'
          ? await retainIncompleteStaging(operation.stagingPath)
          : await removeIfOurs(operation.stagingPath, operation.expectedHash, 'staging file')
      if (result === 'retained') clean = false
    }
    if (operation.status === 'published' || operation.status === 'applied') {
      const result = await removeIfOurs(operation.path, operation.expectedHash, 'file')
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
  const restoring = (operation: TransactionJournal['operations'][number]): boolean =>
    operation.kind === 'replace-file' || operation.kind === 'remove-file'

  for (const operation of input.journal.operations) {
    if (operation.status === 'planned') continue
    // Names that must be gone: staging entries, backups, and any target this
    // transaction created.
    const absent: string[] = []
    if (operation.stagingPath) absent.push(operation.stagingPath)
    if (operation.backupPath) absent.push(operation.backupPath)
    if (
      operation.kind === 'create-directory' ||
      ((operation.kind === 'create-file' || operation.kind === 'remove-directory') &&
        (operation.status === 'published' || operation.status === 'applied'))
    ) {
      absent.push(operation.path)
    }
    for (const path of absent) {
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

    // A replaced or removed file must be back, byte for byte.
    if (restoring(operation) && operation.backupHash) {
      if (retained.has(operation.path)) continue
      const directory = parentDirectory(operation.path) ?? ''
      const name = baseName(operation.path)
      try {
        await fs.withinDirectory(root, directory, async (bound) => {
          const stat = await bound.lstat(name)
          if (!stat || stat.kind !== 'file') {
            retain(operation.path, 'original file was not restored')
            return
          }
          if (sha256(await bound.readFile(name)) !== operation.backupHash) {
            retain(operation.path, 'restored content does not match the original')
          }
        })
      } catch (error) {
        if (ancestorMissing(error)) {
          retain(operation.path, 'original file was not restored')
          continue
        }
        retain(operation.path, `could not verify restoration (${describe(error)})`)
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
