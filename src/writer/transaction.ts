import { hasErrors, type Diagnostic } from '../core/diagnostics.js'
import {
  JOURNAL_PATH,
  LOCK_PATH,
  WRKRS_DIRECTORY,
  type JournalOperation,
  type TransactionJournal,
} from '../core/ownership.js'
import type { Conflict, InstallPlan, PlanOperation } from '../core/plan.js'
import {
  FileSystemError,
  type ClockPort,
  type EnvironmentPort,
  type FileSystemPort,
  type IdPort,
} from '../core/ports.js'
import { formatTimestamp } from '../platform/clock.js'
import { sha256 } from '../platform/hash.js'
import { ancestorDirectories, baseName, parentDirectory, toSystemPath } from '../platform/paths.js'
import { conflict } from '../planner/conflicts.js'
import { MANIFEST_SOURCE_ID } from '../planner/digest.js'
import { GENERATED_DIRECTORY_MODE } from '../planner/operations.js'
import {
  createJournal,
  persistJournal,
  plannedOperation,
  withOperation,
  withStatus,
} from './journal.js'
import { recheckPreconditions } from './preconditions.js'
import { rollbackTransaction, type RetainedPath } from './rollback.js'

export interface WriterPorts {
  readonly fs: FileSystemPort
  readonly clock: ClockPort
  readonly ids: IdPort
  readonly environment: EnvironmentPort
}

export interface ApplyInput {
  readonly plan: InstallPlan
  /** Post-write validation using the same rules as `wrkrs check`. Errors fail the transaction. */
  readonly validate: (context: { transactionId: string }) => Promise<readonly Diagnostic[]>
}

export type ApplyResult =
  | {
      readonly status: 'applied'
      readonly transactionId: string
      readonly appliedPaths: readonly string[]
      readonly createdDirectories: readonly string[]
      readonly diagnostics: readonly Diagnostic[]
    }
  | { readonly status: 'aborted'; readonly conflicts: readonly Conflict[] }
  | {
      readonly status: 'rolled-back'
      readonly transactionId: string
      readonly failure: string
      readonly diagnostics: readonly Diagnostic[]
    }
  | {
      readonly status: 'rollback-incomplete'
      readonly transactionId: string
      readonly failure: string
      readonly retained: readonly RetainedPath[]
      readonly journalPath: string
      readonly diagnostics: readonly Diagnostic[]
    }

class TransactionFailure extends Error {
  readonly diagnostics: readonly Diagnostic[]
  constructor(message: string, diagnostics: readonly Diagnostic[] = []) {
    super(message)
    this.name = 'TransactionFailure'
    this.diagnostics = diagnostics
  }
}

function orderedCreates(plan: InstallPlan): PlanOperation[] {
  const creates = plan.operations.filter((operation) => operation.outcome === 'create')
  const manifest = creates.filter((operation) => operation.sourceId === MANIFEST_SOURCE_ID)
  const others = creates
    .filter((operation) => operation.sourceId !== MANIFEST_SOURCE_ID)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return [...others, ...manifest]
}

function stagingPathFor(path: string, transactionId: string): string {
  const parent = parentDirectory(path)
  const name = `.${baseName(path)}.wrkrs-${transactionId.slice(0, 8)}.tmp`
  return parent === null ? name : `${parent}/${name}`
}

async function safeUnlink(fs: FileSystemPort, systemPath: string): Promise<void> {
  try {
    await fs.unlink(systemPath)
  } catch (error) {
    if (error instanceof FileSystemError && error.code === 'ENOENT') return
    throw error
  }
}

/**
 * Applies a validated, unblocked plan through a journaled transaction:
 * lock, recheck, staged writes in deterministic order, post-write hash
 * verification, validation, and reverse rollback on any failure.
 */
export async function applyPlan(input: ApplyInput, ports: WriterPorts): Promise<ApplyResult> {
  const { plan } = input
  const { fs, clock, ids } = ports
  const root = plan.repositoryRoot

  if (plan.blockers.length > 0) {
    return { status: 'aborted', conflicts: plan.blockers }
  }
  const creates = orderedCreates(plan)
  if (creates.length === 0) {
    return {
      status: 'applied',
      transactionId: '',
      appliedPaths: [],
      createdDirectories: [],
      diagnostics: [],
    }
  }

  const journalSystemPath = toSystemPath(root, JOURNAL_PATH)
  const lockSystemPath = toSystemPath(root, LOCK_PATH)
  const wrkrsSystemPath = toSystemPath(root, WRKRS_DIRECTORY)

  if (await fs.lstat(journalSystemPath)) {
    return {
      status: 'aborted',
      conflicts: [
        conflict(
          'OWNERSHIP',
          'OWNERSHIP_TRANSACTION_INTERRUPTED',
          JOURNAL_PATH,
          'An interrupted wrkrs transaction journal is present',
          'Resolve the journal before retrying',
        ),
      ],
    }
  }

  const before = await recheckPreconditions(plan, root, fs)
  if (before.length > 0) return { status: 'aborted', conflicts: before }

  const transactionId = ids.uuid()
  const startedAt = formatTimestamp(clock.now())

  // The lock lives inside .wrkrs, so that directory is the one piece of
  // bookkeeping that may exist before the lock is held. It is a planned
  // created directory and is removed again on any abort or rollback.
  let wrkrsCreated = false
  if (!(await fs.lstat(wrkrsSystemPath))) {
    if (!plan.createdDirectories.includes(WRKRS_DIRECTORY)) {
      return {
        status: 'aborted',
        conflicts: [
          conflict(
            'PRECONDITION',
            'PRECONDITION_DIRECTORY_MISSING',
            WRKRS_DIRECTORY,
            '.wrkrs is absent but the plan did not expect to create it',
            'Run `wrkrs init --dry-run` again',
          ),
        ],
      }
    }
    try {
      await fs.makeDirectory(wrkrsSystemPath, GENERATED_DIRECTORY_MODE)
    } catch (error) {
      return {
        status: 'aborted',
        conflicts: [
          conflict(
            'PRECONDITION',
            'PRECONDITION_TARGET_CHANGED',
            WRKRS_DIRECTORY,
            `Could not create .wrkrs: ${error instanceof Error ? error.message : String(error)}`,
            'Run `wrkrs init --dry-run` again',
          ),
        ],
      }
    }
    wrkrsCreated = true
  }

  const lockContent = JSON.stringify(
    { transactionId, pid: ports.environment.processId, startedAt },
    null,
    2,
  )
  try {
    await fs.writeFileExclusive(lockSystemPath, new TextEncoder().encode(lockContent + '\n'), 0o644)
  } catch (error) {
    if (wrkrsCreated) await fs.removeDirectory(wrkrsSystemPath).catch(() => undefined)
    const code = error instanceof FileSystemError ? error.code : 'EUNKNOWN'
    return {
      status: 'aborted',
      conflicts: [
        conflict(
          'OWNERSHIP',
          code === 'EEXIST' ? 'OWNERSHIP_LOCK_PRESENT' : 'OWNERSHIP_LOCK_FAILED',
          LOCK_PATH,
          code === 'EEXIST'
            ? 'Another wrkrs installation holds the lock'
            : `Could not acquire the installation lock (${code})`,
          'Ensure no other wrkrs process is running, then remove a stale lock file and retry',
        ),
      ],
    }
  }

  // .wrkrs itself is transaction bookkeeping (it holds the journal and lock),
  // so it is tracked separately and removed last rather than journaled.
  const journalOperations: JournalOperation[] = []
  const listedDirectories = new Set<string>()
  if (wrkrsCreated) listedDirectories.add(WRKRS_DIRECTORY)
  for (const operation of creates) {
    for (const ancestor of ancestorDirectories(operation.path)) {
      if (plan.createdDirectories.includes(ancestor) && !listedDirectories.has(ancestor)) {
        journalOperations.push(plannedOperation(ancestor, 'create-directory'))
        listedDirectories.add(ancestor)
      }
    }
    journalOperations.push(plannedOperation(operation.path, 'create-file'))
  }

  let journal: TransactionJournal = createJournal({
    transactionId,
    planDigest: plan.digest,
    startedAt,
    operations: journalOperations,
  })
  const persist = (next: TransactionJournal) => persistJournal(fs, journalSystemPath, next, clock)

  const releaseBookkeeping = async (): Promise<void> => {
    await safeUnlink(fs, journalSystemPath)
    await safeUnlink(fs, lockSystemPath)
    if (wrkrsCreated) await fs.removeDirectory(wrkrsSystemPath).catch(() => undefined)
  }

  try {
    journal = await persist(journal)
  } catch (error) {
    await releaseBookkeeping()
    return {
      status: 'aborted',
      conflicts: [
        conflict(
          'PRECONDITION',
          'PRECONDITION_JOURNAL_UNWRITABLE',
          JOURNAL_PATH,
          `Could not write the transaction journal: ${error instanceof Error ? error.message : String(error)}`,
          'Check filesystem permissions and retry',
        ),
      ],
    }
  }

  const after = await recheckPreconditions(plan, root, fs, {
    allowExistingDirectories: new Set(wrkrsCreated ? [WRKRS_DIRECTORY] : []),
  })
  if (after.length > 0) {
    await releaseBookkeeping()
    return { status: 'aborted', conflicts: after }
  }

  const appliedPaths: string[] = []
  const createdDirectories: string[] = wrkrsCreated ? [WRKRS_DIRECTORY] : []
  const created = new Set(createdDirectories)

  try {
    journal = await persist(withStatus(journal, 'applying'))

    for (const operation of creates) {
      for (const ancestor of ancestorDirectories(operation.path)) {
        if (!plan.createdDirectories.includes(ancestor) || created.has(ancestor)) continue
        await fs.makeDirectory(toSystemPath(root, ancestor), GENERATED_DIRECTORY_MODE)
        created.add(ancestor)
        createdDirectories.push(ancestor)
        journal = await persist(withOperation(journal, ancestor, { status: 'applied' }))
      }

      const bytes = operation.proposedBytes
      if (!bytes || operation.proposedHash === null || operation.mode === null) {
        throw new TransactionFailure(`Operation for ${operation.path} carries no content`)
      }
      const stagingPath = stagingPathFor(operation.path, transactionId)
      const stagingSystemPath = toSystemPath(root, stagingPath)
      const targetSystemPath = toSystemPath(root, operation.path)

      await fs.writeFileExclusive(stagingSystemPath, bytes, operation.mode)
      journal = await persist(
        withOperation(journal, operation.path, { status: 'staged', stagingPath }),
      )

      if (await fs.lstat(targetSystemPath)) {
        throw new TransactionFailure(`Precondition failed: ${operation.path} appeared during apply`)
      }
      await fs.rename(stagingSystemPath, targetSystemPath)

      const written = await fs.readFile(targetSystemPath)
      const appliedHash = sha256(written)
      if (appliedHash !== operation.proposedHash) {
        journal = await persist(
          withOperation(journal, operation.path, {
            status: 'applied',
            stagingPath: null,
            appliedHash,
          }),
        )
        throw new TransactionFailure(
          `Post-write verification failed for ${operation.path}: content hash does not match the plan`,
        )
      }
      appliedPaths.push(operation.path)
      journal = await persist(
        withOperation(journal, operation.path, {
          status: 'applied',
          stagingPath: null,
          appliedHash,
        }),
      )
    }

    journal = await persist(withStatus(journal, 'validating'))
    const diagnostics = await input.validate({ transactionId })
    if (hasErrors(diagnostics)) {
      const summary = diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => `${diagnostic.code}${diagnostic.path ? ` (${diagnostic.path})` : ''}`)
        .join(', ')
      throw new TransactionFailure(`Post-apply validation failed: ${summary}`, diagnostics)
    }

    journal = await persist(withStatus(journal, 'committed'))
    await safeUnlink(fs, journalSystemPath)
    await safeUnlink(fs, lockSystemPath)
    return { status: 'applied', transactionId, appliedPaths, createdDirectories, diagnostics }
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    const diagnostics = error instanceof TransactionFailure ? error.diagnostics : []
    try {
      journal = await persist(withStatus(journal, 'rolling-back', failure))
    } catch {
      // Best effort; rollback proceeds from in-memory journal state.
    }
    const outcome = await rollbackTransaction({ root, fs, journal, persist })
    journal = outcome.journal

    if (outcome.retained.length === 0) {
      try {
        await persist(withStatus(journal, 'rolled-back', failure))
      } catch {
        // The journal is removed next; a failed final write is not material.
      }
      await safeUnlink(fs, journalSystemPath)
      await safeUnlink(fs, lockSystemPath)
      if (wrkrsCreated) {
        try {
          await fs.removeDirectory(wrkrsSystemPath)
        } catch (removeError) {
          return {
            status: 'rollback-incomplete',
            transactionId,
            failure,
            retained: [
              {
                path: WRKRS_DIRECTORY,
                reason: removeError instanceof Error ? removeError.message : String(removeError),
              },
            ],
            journalPath: JOURNAL_PATH,
            diagnostics,
          }
        }
      }
      return { status: 'rolled-back', transactionId, failure, diagnostics }
    }

    try {
      await persist(withStatus(journal, 'rollback-incomplete', failure))
    } catch {
      // Retained paths are still reported to the user below.
    }
    await safeUnlink(fs, lockSystemPath)
    return {
      status: 'rollback-incomplete',
      transactionId,
      failure,
      retained: outcome.retained,
      journalPath: JOURNAL_PATH,
      diagnostics,
    }
  }
}
