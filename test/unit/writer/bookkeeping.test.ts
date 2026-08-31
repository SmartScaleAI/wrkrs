import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runCheck } from '../../../src/check/check.js'
import { createStyler, renderApplyResult } from '../../../src/cli/output/human-reporter.js'
import { parseJournalDocument } from '../../../src/config/load.js'
import { FileSystemError } from '../../../src/core/ports.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import {
  createTestDependencies,
  createTestPorts,
  interceptFileSystem,
  type FileSystemInterceptors,
} from '../../helpers/ports.js'
import {
  createFixtureRepository,
  hashTree,
  readTree,
  removeDir,
  type FixtureName,
} from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const AGENTS = '.claude/agents'
const JOURNAL_TEMP = /^\.journal\.json\.[0-9a-f]{8}\.tmp$/

async function prepare(root: string, ports: InitPorts) {
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return prepared.value
}

function repo(fixture: FixtureName = 'clean-repository'): string {
  const root = createFixtureRepository(fixture, { commit: true })
  cleanup.push(root)
  return root
}

async function checkReport(root: string) {
  const deps = createTestDependencies()
  return runCheck(
    {
      cwd: root,
      wrkrsVersion: deps.wrkrsVersion,
      adapters: deps.adapters,
      providers: deps.providers,
    },
    createTestPorts(),
  )
}

/** Fails the first .wrkrs directory sync (the one right after the lock write) with a real EIO. */
function failFirstWrkrsSync(extra: FileSystemInterceptors['bound'] = {}) {
  let failures = 0
  const interceptors: FileSystemInterceptors = {
    bound: {
      ...extra,
      sync: async (args, next, directory) => {
        if (directory.relativePath === '.wrkrs' && failures === 0) {
          failures += 1
          throw new FileSystemError(
            'EIO',
            '.wrkrs',
            'injected directory sync failure after lock creation',
          )
        }
        return next(...args)
      },
    },
  }
  return { fs: interceptFileSystem(createTestPorts().fs, interceptors), failures: () => failures }
}

/**
 * Forces rollback-incomplete with one genuinely retained repository path: the
 * software-engineer write fails, and the already published product-manager
 * agent cannot be removed. Extra interceptors run for every other name.
 */
function agentRetainedRollback(extra: FileSystemInterceptors['bound'] = {}) {
  return interceptFileSystem(createTestPorts().fs, {
    bound: {
      ...extra,
      writeFileExclusive: async (args, next, directory) => {
        if (args[0].includes('wrkrs-software-engineer')) throw new Error('injected write failure')
        return extra.writeFileExclusive
          ? extra.writeFileExclusive(args, next, directory)
          : next(...args)
      },
      unlink: async (args, next, directory) => {
        if (directory.relativePath === AGENTS && args[0] === 'wrkrs-product-manager.md') {
          throw new FileSystemError('EPERM', args[0], 'injected: cannot remove the agent')
        }
        return extra.unlink ? extra.unlink(args, next, directory) : next(...args)
      },
    },
  })
}

/** Every path reported as removed-but-not-proven-durable. */
function unprovenPaths(retained: readonly { path: string; reason: string }[]): string[] {
  return retained.filter((item) => item.reason.includes('not proven durable')).map((i) => i.path)
}

describe('finding 2: lock creation is tracked separately from the directory sync', () => {
  it('reconciles the created lock when the sync fails in a transaction-created .wrkrs and restores the exact tree', async () => {
    const root = repo()
    const before = hashTree(root)
    const { fs, failures } = failFirstWrkrsSync()
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(failures()).toBe(1)
    expect(result.status).toBe('aborted')
    if (result.status === 'aborted') {
      expect(result.conflicts.map((conflict) => conflict.code)).toEqual(['OWNERSHIP_LOCK_FAILED'])
    }
    expect(existsSync(path.join(root, '.wrkrs', '.lock'))).toBe(false)
    expect(existsSync(path.join(root, '.wrkrs'))).toBe(false)
    expect(hashTree(root)).toBe(before)
  })

  it('reconciles the created lock when the sync fails in a pre-existing .wrkrs directory', async () => {
    const root = repo()
    let rootLstats = 0
    const base = failFirstWrkrsSync()
    const fs = interceptFileSystem(base.fs, {
      bound: {
        lstat: async (args, next, directory) => {
          // The second root-level lstat of .wrkrs is the transaction's presence
          // check (the first belongs to the precondition recheck); make the
          // directory exist just before it so the transaction does not create it.
          if (directory.relativePath === '' && args[0] === '.wrkrs') {
            rootLstats += 1
            if (rootLstats === 2) mkdirSync(path.join(root, '.wrkrs'))
          }
          return next(...args)
        },
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(base.failures()).toBe(1)
    expect(result.status).toBe('aborted')
    if (result.status === 'aborted') {
      expect(result.conflicts.map((conflict) => conflict.code)).toEqual(['OWNERSHIP_LOCK_FAILED'])
    }
    // Never plain aborted while the lock exists: the lock is gone, the
    // pre-existing directory stays (empty), and nothing else changed.
    expect(existsSync(path.join(root, '.wrkrs', '.lock'))).toBe(false)
    expect(existsSync(path.join(root, '.wrkrs'))).toBe(true)
    expect(readdirSync(path.join(root, '.wrkrs'))).toEqual([])
    expect(readTree(root).filter((entry) => entry.path.startsWith('.claude'))).toEqual([])
  })

  it('reports the exact lock path with a readable recovery journal when the created lock cannot be removed', async () => {
    const root = repo()
    const { fs } = failFirstWrkrsSync({
      unlink: async (args, next, directory) => {
        if (directory.relativePath === '.wrkrs' && args[0] === '.lock') {
          throw new FileSystemError('EPERM', args[0], 'injected: cannot remove the lock')
        }
        return next(...args)
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status === 'rollback-incomplete') {
      expect(result.retained.map((item) => item.path)).toContain('.wrkrs/.lock')
    }
    expect(existsSync(path.join(root, '.wrkrs', '.lock'))).toBe(true)
    const journal = parseJournalDocument(
      readFileSync(path.join(root, '.wrkrs', '.journal.json'), 'utf8'),
    )
    expect(journal.ok && journal.value.status).toBe('rollback-incomplete')
    const report = await checkReport(root)
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'TRANSACTION_INTERRUPTED',
    )
  })
})

describe('finding 3: the final rollback-incomplete exit releases the lock durably', () => {
  /** Forces a rollback-incomplete by blocking removal of one published agent. */
  function incompleteRollback(extra: FileSystemInterceptors['bound'] = {}) {
    return interceptFileSystem(createTestPorts().fs, {
      bound: {
        ...extra,
        writeFileExclusive: async (args, next, directory) => {
          if (args[0].includes('wrkrs-software-engineer')) throw new Error('injected write failure')
          if (extra.writeFileExclusive) return extra.writeFileExclusive(args, next, directory)
          return next(...args)
        },
      },
    })
  }
  const blockAgentRemoval: FileSystemInterceptors['bound'] = {
    unlink: async (args, next, directory) => {
      if (directory.relativePath === AGENTS && args[0] === 'wrkrs-product-manager.md') {
        throw new FileSystemError('EPERM', args[0], 'injected: cannot remove the agent')
      }
      return next(...args)
    },
  }

  it('reports the lock when its unlink fails during the final exit', async () => {
    const root = repo('existing-claude-repository')
    const fs = incompleteRollback({
      unlink: async (args, next, directory) => {
        if (directory.relativePath === AGENTS && args[0] === 'wrkrs-product-manager.md') {
          throw new FileSystemError('EPERM', args[0], 'injected: cannot remove the agent')
        }
        if (directory.relativePath === '.wrkrs' && args[0] === '.lock') {
          throw new FileSystemError('EPERM', args[0], 'injected: cannot remove the lock')
        }
        return next(...args)
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    const paths = result.retained.map((item) => item.path)
    expect(paths).toContain('.wrkrs/.lock')
    expect(paths).toContain(`${AGENTS}/wrkrs-product-manager.md`)
    expect(new Set(paths).size).toBe(paths.length)
    expect(existsSync(path.join(root, '.wrkrs', '.lock'))).toBe(true)
    const journal = parseJournalDocument(
      readFileSync(path.join(root, '.wrkrs', '.journal.json'), 'utf8'),
    )
    expect(journal.ok && journal.value.status).toBe('rollback-incomplete')
  })

  // A-020 finding 2: this scenario previously reported .wrkrs/.lock as
  // durability-unproven even though the final journal write syncs the same
  // directory and therefore proves the lock removal durable. The expectation
  // intentionally changed from "retained" to "reconciled"; the lock is still
  // reported whenever no later sync proves it (see the persistent case below).
  it('clears the lock entry when a later journal-persist sync proves the removal durable', async () => {
    const root = repo('existing-claude-repository')
    let lockUnlinked = false
    let syncFailures = 0
    const fs = agentRetainedRollback({
      unlink: async (args, next, directory) => {
        const result = await next(...args)
        if (directory.relativePath === '.wrkrs' && args[0] === '.lock') lockUnlinked = true
        return result
      },
      sync: async (args, next, directory) => {
        if (directory.relativePath === '.wrkrs' && lockUnlinked && syncFailures === 0) {
          syncFailures += 1
          throw new FileSystemError('EIO', '.wrkrs', 'injected sync failure after lock removal')
        }
        return next(...args)
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(syncFailures).toBe(1)
    // The result stays incomplete because the agent is genuinely retained.
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    const paths = result.retained.map((item) => item.path)
    expect(paths).toContain(`${AGENTS}/wrkrs-product-manager.md`)
    expect(paths).not.toContain('.wrkrs/.lock')
    expect(unprovenPaths(result.retained)).toEqual([])
    expect(new Set(paths).size).toBe(paths.length)
    expect(existsSync(path.join(root, '.wrkrs', '.lock'))).toBe(false)
    const journal = parseJournalDocument(
      readFileSync(path.join(root, '.wrkrs', '.journal.json'), 'utf8'),
    )
    expect(journal.ok).toBe(true)
    if (!journal.ok) return
    expect(journal.value.status).toBe('rollback-incomplete')
    // The journal never claims more durability than was proven when written.
    expect(journal.value.durability).toBe('best-effort')
  })

  it('detects a faked lock unlink where the lock remains', async () => {
    const root = repo('existing-claude-repository')
    const fs = incompleteRollback({
      ...blockAgentRemoval,
      unlink: async (args, next, directory) => {
        if (directory.relativePath === AGENTS && args[0] === 'wrkrs-product-manager.md') {
          throw new FileSystemError('EPERM', args[0], 'injected: cannot remove the agent')
        }
        // Pretend the lock removal succeeded while the entry stays on disk.
        if (directory.relativePath === '.wrkrs' && args[0] === '.lock') return
        return next(...args)
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    const lock = result.retained.find((item) => item.path === '.wrkrs/.lock')
    expect(lock).toBeDefined()
    expect(lock!.reason).toContain('still present')
    expect(existsSync(path.join(root, '.wrkrs', '.lock'))).toBe(true)
  })
})

describe('finding 4: a successful installation keeps .wrkrs and warns about nothing', () => {
  it.each(['clean-repository', 'existing-claude-repository'] as FixtureName[])(
    'installs %s without a bookkeeping warning and retains the installed .wrkrs contents',
    async (fixture) => {
      const root = repo(fixture)
      const ports = createTestPorts()
      const prepared = await prepare(root, ports)
      const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
      expect(result.status).toBe('applied')
      if (result.status !== 'applied') return
      expect(result.durability).toBe('strict')
      const codes = result.diagnostics.map((diagnostic) => diagnostic.code)
      expect(codes).not.toContain('TRANSACTION_BOOKKEEPING_RETAINED')
      expect(codes).not.toContain('TRANSACTION_BOOKKEEPING_DURABILITY_UNPROVEN')
      const human = renderApplyResult(result, createStyler(false))
      expect(human).not.toContain('Transaction bookkeeping')
      expect(human).not.toContain('Remove the file manually')
      for (const file of [
        '.wrkrs/config.yaml',
        '.wrkrs/schema.json',
        '.wrkrs/manifest.json',
        '.wrkrs/roles/product-manager.md',
        '.wrkrs/roles/product-designer.md',
        '.wrkrs/roles/software-engineer.md',
        '.wrkrs/roles/qa-engineer.md',
      ]) {
        expect(existsSync(path.join(root, ...file.split('/')))).toBe(true)
      }
      expect(existsSync(path.join(root, '.wrkrs', '.lock'))).toBe(false)
      expect(existsSync(path.join(root, '.wrkrs', '.journal.json'))).toBe(false)
      const report = await checkReport(root)
      expect(report.ok).toBe(true)
    },
  )
})

describe('finding 5: journal-temp retention reflects proven state', () => {
  it('does not report a temp that failed cleanup once and was removed during bookkeeping release', async () => {
    const root = repo('existing-claude-repository')
    const before = hashTree(root)
    let renameFailures = 0
    let tempUnlinkFailures = 0
    let persistCount = 0
    const fs = interceptFileSystem(createTestPorts().fs, {
      bound: {
        rename: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && args[1] === '.journal.json') {
            persistCount += 1
            if (persistCount === 3 && renameFailures === 0) {
              renameFailures += 1
              throw new FileSystemError('EIO', args[1], 'injected journal rename failure')
            }
          }
          return next(...args)
        },
        unlink: async (args, next, directory) => {
          if (
            directory.relativePath === '.wrkrs' &&
            JOURNAL_TEMP.test(args[0]) &&
            tempUnlinkFailures === 0
          ) {
            tempUnlinkFailures += 1
            throw new FileSystemError('EPERM', args[0], 'injected: temp cleanup fails once')
          }
          return next(...args)
        },
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(renameFailures).toBe(1)
    expect(tempUnlinkFailures).toBe(1)
    // The retry during bookkeeping release removed the temp and proved it, so
    // the result must not be rollback-incomplete naming a nonexistent file.
    expect(result.status).toBe('rolled-back')
    expect(readTree(root).some((entry) => JOURNAL_TEMP.test(path.posix.basename(entry.path)))).toBe(
      false,
    )
    expect(hashTree(root)).toBe(before)
  })
})

describe('A-020 finding 1: a failed cleanup sync is attributed to every exact path', () => {
  it('reports .wrkrs/.lock, not .wrkrs, when the cleanup sync fails after the lock was removed', async () => {
    const root = repo()
    const before = hashTree(root)
    // Both .wrkrs syncs fail: the one after the lock write, and the one that
    // would prove the cleanup removal durable.
    let failures = 0
    const fs = interceptFileSystem(createTestPorts().fs, {
      bound: {
        sync: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && failures < 2) {
            failures += 1
            throw new FileSystemError('EIO', '.wrkrs', 'injected .wrkrs directory sync failure')
          }
          return next(...args)
        },
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(failures).toBe(2)
    // No plain aborted or rolled-back result while a removal is unproven.
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    const paths = result.retained.map((item) => item.path)
    expect(paths).toEqual(['.wrkrs/.lock'])
    expect(unprovenPaths(result.retained)).toEqual(['.wrkrs/.lock'])
    // .wrkrs is never a substitute retained path for an individual file, and
    // the live journal is not reported: it never existed in this transaction.
    expect(paths).not.toContain('.wrkrs')
    expect(paths).not.toContain('.wrkrs/.journal.json')
    expect(new Set(paths).size).toBe(paths.length)
    // Recovery bookkeeping is as honest as the filesystem permits: the lock
    // and the directory this transaction created are gone, so there is
    // nothing left to recover from and the tree is exactly as it was.
    expect(existsSync(path.join(root, '.wrkrs'))).toBe(false)
    expect(hashTree(root)).toBe(before)
  })

  it('replaces a stale unlink-failure reason with durability-unproven when the retry removes the temp', async () => {
    const root = repo()
    const before = hashTree(root)
    let renameFailures = 0
    let tempUnlinkFailures = 0
    let tempRemoved = false
    let syncFailures = 0
    let persistCount = 0
    const fs = interceptFileSystem(createTestPorts().fs, {
      bound: {
        rename: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && args[1] === '.journal.json') {
            persistCount += 1
            if (persistCount === 3 && renameFailures === 0) {
              renameFailures += 1
              throw new FileSystemError('EIO', args[1], 'injected journal rename failure')
            }
          }
          return next(...args)
        },
        unlink: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && JOURNAL_TEMP.test(args[0])) {
            if (tempUnlinkFailures === 0) {
              tempUnlinkFailures += 1
              throw new FileSystemError('EPERM', args[0], 'injected: temp cleanup fails once')
            }
            const result = await next(...args)
            tempRemoved = true
            return result
          }
          return next(...args)
        },
        sync: async (args, next, directory) => {
          // Fail only the release sync that would prove the retry durable.
          if (directory.relativePath === '.wrkrs' && tempRemoved && syncFailures === 0) {
            syncFailures += 1
            throw new FileSystemError('EIO', '.wrkrs', 'injected release sync failure')
          }
          return next(...args)
        },
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(renameFailures).toBe(1)
    expect(tempUnlinkFailures).toBe(1)
    expect(syncFailures).toBe(1)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    const temp = result.retained.filter((item) => JOURNAL_TEMP.test(path.posix.basename(item.path)))
    expect(temp).toHaveLength(1)
    expect(temp[0]!.path.startsWith('.wrkrs/.journal.json.')).toBe(true)
    // The retry removed it, so the earlier "could not be removed" reason is
    // stale and must not survive.
    expect(temp[0]!.reason).toContain('not proven durable')
    expect(temp[0]!.reason).not.toContain('could not be removed')
    // Each removal awaiting that one sync is named exactly, once.
    const paths = result.retained.map((item) => item.path)
    expect(paths).toContain('.wrkrs/.lock')
    expect(paths).toContain('.wrkrs/.journal.json')
    expect(paths).not.toContain('.wrkrs')
    expect(new Set(paths).size).toBe(paths.length)
    expect(unprovenPaths(result.retained).sort()).toEqual([...paths].sort())
    expect(hashTree(root)).toBe(before)
  })
})

describe('A-020 finding 2: an unproven removal survives when no later sync proves it', () => {
  it('keeps the exact lock entry when every .wrkrs sync after the removal fails', async () => {
    const root = repo('existing-claude-repository')
    /** The repository as it was, excluding anything wrkrs generates. */
    const original = (): unknown[] =>
      readTree(root).filter(
        (entry) => !entry.path.includes('wrkrs-') && !entry.path.startsWith('.wrkrs'),
      )
    const fixture = original()
    let lockUnlinked = false
    let syncFailures = 0
    const fs = agentRetainedRollback({
      unlink: async (args, next, directory) => {
        const result = await next(...args)
        if (directory.relativePath === '.wrkrs' && args[0] === '.lock') lockUnlinked = true
        return result
      },
      sync: async (args, next, directory) => {
        if (directory.relativePath === '.wrkrs' && lockUnlinked) {
          syncFailures += 1
          throw new FileSystemError('EIO', '.wrkrs', 'injected persistent sync failure')
        }
        return next(...args)
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    // The lock-release sync and the final journal write's sync both failed.
    expect(syncFailures).toBeGreaterThanOrEqual(2)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    const paths = result.retained.map((item) => item.path)
    expect(paths).toContain('.wrkrs/.lock')
    expect(paths).toContain(`${AGENTS}/wrkrs-product-manager.md`)
    expect(unprovenPaths(result.retained)).toEqual(['.wrkrs/.lock'])
    expect(paths).not.toContain('.wrkrs')
    expect(new Set(paths).size).toBe(paths.length)
    expect(existsSync(path.join(root, '.wrkrs', '.lock'))).toBe(false)
    // The recovery record is honest about the interrupted transaction.
    const journal = parseJournalDocument(
      readFileSync(path.join(root, '.wrkrs', '.journal.json'), 'utf8'),
    )
    expect(journal.ok).toBe(true)
    if (!journal.ok) return
    expect(journal.value.status).toBe('rollback-incomplete')
    expect(journal.value.durability).toBe('best-effort')
    const report = await checkReport(root)
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'TRANSACTION_INTERRUPTED',
    )
    // The pre-existing Claude configuration is untouched, byte and mode.
    expect(original()).toEqual(fixture)
  })
})
