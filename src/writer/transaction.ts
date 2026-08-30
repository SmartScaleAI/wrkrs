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
  journalStagingPath,
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
      /** Stable conflict when the failure was a precondition (for example a target that appeared). */
      readonly conflict: Conflict | null
      readonly diagnostics: readonly Diagnostic[]
    }
  | {
      readonly status: 'rollback-incomplete'
      readonly transactionId: string
      readonly failure: string
      readonly conflict: Conflict | null
      readonly retained: readonly RetainedPath[]
      readonly journalPath: string
      readonly diagnostics: readonly Diagnostic[]
    }

class TransactionFailure extends Error {
  readonly diagnostics: readonly Diagnostic[]
  readonly conflict: Conflict | null
  constructor(
    message: string,
    options: { diagnostics?: readonly Diagnostic[]; conflict?: Conflict | null } = {},
  ) {
    super(message)
    this.name = 'TransactionFailure'
    this.diagnostics = options.diagnostics ?? []
    this.conflict = options.conflict ?? null
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

async function safeUnlink(fs: FileSystemPort, systemPath: string): Promise<boolean> {
  try {
    await fs.unlink(systemPath)
    return true
  } catch (error) {
    if (error instanceof FileSystemError && error.code === 'ENOENT') return true
    return false
  }
}

async function isAbsent(fs: FileSystemPort, systemPath: string): Promise<boolean> {
  try {
    return (await fs.lstat(systemPath)) === null
  } catch {
    return false
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof TransactionFailure) return error.message
  if (error instanceof FileSystemError) return `${error.code} at ${error.path}`
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Applies a validated, unblocked plan through a journaled transaction:
 * lock, recheck, staged writes in deterministic order, atomic no-replace
 * publication, post-publication hash verification, validation, and
 * hash-guarded reverse rollback on any failure.
 *
 * Journal state is advanced in memory before each attempt to persist it, so
 * a persistence failure can never hide a published target from rollback, and
 * every journal write replaces the file atomically so the previous record
 * survives a failed write.
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
  const journalTempSystemPath = journalStagingPath(journalSystemPath, transactionId)

  // The lock lives inside .wrkrs, so that directory is the one piece of
  // bookkeeping that may exist before the lock is held. It is a planned
  // created directory and is removed again on any abort or complete rollback.
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
            `Could not create .wrkrs (${describeFailure(error)})`,
            'Run `wrkrs init --dry-run` again',
          ),
        ],
      }
    }
    wrkrsCreated = true
  }

  const releaseBookkeeping = async (): Promise<string[]> => {
    const remaining: string[] = []
    if (!(await safeUnlink(fs, journalTempSystemPath)))
      remaining.push(`${JOURNAL_PATH} (temporary)`)
    if (!(await safeUnlink(fs, journalSystemPath))) remaining.push(JOURNAL_PATH)
    if (!(await safeUnlink(fs, lockSystemPath))) remaining.push(LOCK_PATH)
    if (wrkrsCreated) {
      try {
        await fs.removeDirectory(wrkrsSystemPath)
      } catch (error) {
        if (!(error instanceof FileSystemError && error.code === 'ENOENT')) {
          remaining.push(WRKRS_DIRECTORY)
        }
      }
    }
    return remaining
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
    journalOperations.push(
      plannedOperation(operation.path, 'create-file', 'planned', operation.proposedHash),
    )
  }

  let journal: TransactionJournal = createJournal({
    transactionId,
    planDigest: plan.digest,
    startedAt,
    operations: journalOperations,
  })
  const persist = (next: TransactionJournal) => persistJournal(fs, journalSystemPath, next, clock)

  try {
    journal = await persist(journal)
  } catch (error) {
    const remaining = await releaseBookkeeping()
    if (remaining.length > 0) {
      return {
        status: 'rollback-incomplete',
        transactionId,
        failure: `Could not write the transaction journal (${describeFailure(error)})`,
        conflict: null,
        retained: remaining.map((path) => ({ path, reason: 'bookkeeping could not be removed' })),
        journalPath: JOURNAL_PATH,
        diagnostics: [],
      }
    }
    return {
      status: 'aborted',
      conflicts: [
        conflict(
          'PRECONDITION',
          'PRECONDITION_JOURNAL_UNWRITABLE',
          JOURNAL_PATH,
          `Could not write the transaction journal (${describeFailure(error)})`,
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

  // Advances the in-memory journal first, then attempts to persist it. The
  // in-memory record is what rollback reconciles against.
  const advance = async (next: TransactionJournal): Promise<void> => {
    journal = next
    journal = await persist(journal)
  }

  try {
    await advance(withStatus(journal, 'applying'))

    for (const operation of creates) {
      for (const ancestor of ancestorDirectories(operation.path)) {
        if (!plan.createdDirectories.includes(ancestor) || created.has(ancestor)) continue
        await fs.makeDirectory(toSystemPath(root, ancestor), GENERATED_DIRECTORY_MODE)
        created.add(ancestor)
        createdDirectories.push(ancestor)
        await advance(withOperation(journal, ancestor, { status: 'applied' }))
      }

      const bytes = operation.proposedBytes
      if (!bytes || operation.proposedHash === null || operation.mode === null) {
        throw new TransactionFailure(`Operation for ${operation.path} carries no content`)
      }
      const expectedHash = operation.proposedHash
      const stagingPath = stagingPathFor(operation.path, transactionId)
      const stagingSystemPath = toSystemPath(root, stagingPath)
      const targetSystemPath = toSystemPath(root, operation.path)

      // 1. Stage: full content written and synced under a temporary name.
      await fs.writeFileExclusive(stagingSystemPath, bytes, operation.mode)
      await advance(
        withOperation(journal, operation.path, { status: 'staged', stagingPath, expectedHash }),
      )

      // 2. Publish atomically without ever replacing an existing entry.
      try {
        await fs.publishFileExclusive(stagingSystemPath, targetSystemPath)
      } catch (error) {
        if (error instanceof FileSystemError && error.code === 'EEXIST') {
          journal = withOperation(journal, operation.path, {
            note: 'target appeared before publication; the existing entry was left untouched',
          })
          throw new TransactionFailure(
            `Precondition failed: "${operation.path}" appeared before publication; the existing entry was left untouched`,
            {
              conflict: conflict(
                'PRECONDITION',
                'PRECONDITION_TARGET_APPEARED',
                operation.path,
                `"${operation.path}" was created by another process during apply; wrkrs did not overwrite it`,
                'Review the file, then run `wrkrs init --dry-run` again',
              ),
            },
          )
        }
        throw error
      }
      journal = withOperation(journal, operation.path, { status: 'published', stagingPath: null })
      await advance(journal)

      // 3. Verify the published bytes.
      const written = await fs.readFile(targetSystemPath)
      const appliedHash = sha256(written)
      if (appliedHash !== expectedHash) {
        throw new TransactionFailure(
          `Post-write verification failed for ${operation.path}: content hash does not match the plan`,
        )
      }
      appliedPaths.push(operation.path)
      journal = withOperation(journal, operation.path, { status: 'applied', appliedHash })
      await advance(journal)
    }

    await advance(withStatus(journal, 'validating'))
    const diagnostics = [...(await input.validate({ transactionId }))]
    if (hasErrors(diagnostics)) {
      const summary = diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => `${diagnostic.code}${diagnostic.path ? ` (${diagnostic.path})` : ''}`)
        .join(', ')
      throw new TransactionFailure(`Post-apply validation failed: ${summary}`, { diagnostics })
    }

    await advance(withStatus(journal, 'committed'))
    const leftovers = await releaseBookkeeping()
    if (leftovers.length > 0) {
      // The installation is complete; leftover bookkeeping is reported by check.
      diagnostics.push(
        ...leftovers.map((path) => ({
          code: 'TRANSACTION_BOOKKEEPING_RETAINED',
          severity: 'warning' as const,
          message: `Transaction bookkeeping could not be removed: ${path}`,
          path,
          remediation: 'Remove the file manually',
          details: {},
        })),
      )
    }
    return { status: 'applied', transactionId, appliedPaths, createdDirectories, diagnostics }
  } catch (error) {
    const failure = describeFailure(error)
    const diagnostics = error instanceof TransactionFailure ? error.diagnostics : []
    const failureConflict = error instanceof TransactionFailure ? error.conflict : null
    try {
      journal = await persist(withStatus(journal, 'rolling-back', failure))
    } catch {
      journal = withStatus(journal, 'rolling-back', failure)
    }

    const outcome = await rollbackTransaction({ root, fs, journal, persist })
    journal = outcome.journal
    const retained = new Map(outcome.retained.map((item) => [item.path, item.reason] as const))

    if (retained.size === 0) {
      try {
        journal = await persist(withStatus(journal, 'rolled-back', failure))
      } catch {
        journal = withStatus(journal, 'rolled-back', failure)
      }
      const leftovers = await releaseBookkeeping()
      for (const path of leftovers) retained.set(path, 'bookkeeping could not be removed')
      // Final proof: every directory this transaction created must be gone.
      for (const directory of [...createdDirectories].reverse()) {
        if (retained.has(directory)) continue
        if (!(await isAbsent(fs, toSystemPath(root, directory)))) {
          retained.set(directory, 'directory still present after rollback')
        }
      }
      if (retained.size === 0) {
        return {
          status: 'rolled-back',
          transactionId,
          failure,
          conflict: failureConflict,
          diagnostics,
        }
      }
    }

    try {
      await persist(withStatus(journal, 'rollback-incomplete', failure))
    } catch {
      // The retained paths are reported to the caller regardless.
    }
    await safeUnlink(fs, journalTempSystemPath)
    await safeUnlink(fs, lockSystemPath)
    return {
      status: 'rollback-incomplete',
      transactionId,
      failure,
      conflict: failureConflict,
      retained: [...retained.entries()]
        .map(([path, reason]) => ({ path, reason }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      journalPath: JOURNAL_PATH,
      diagnostics,
    }
  }
}
