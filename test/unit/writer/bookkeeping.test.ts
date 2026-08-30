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

  it('reports the lock as durability-unproven when its removal succeeds but the directory sync fails', async () => {
    const root = repo('existing-claude-repository')
    let lockUnlinked = false
    let synced = 0
    const fs = incompleteRollback({
      ...blockAgentRemoval,
      unlink: async (args, next, directory) => {
        if (directory.relativePath === AGENTS && args[0] === 'wrkrs-product-manager.md') {
          throw new FileSystemError('EPERM', args[0], 'injected: cannot remove the agent')
        }
        const result = await next(...args)
        if (directory.relativePath === '.wrkrs' && args[0] === '.lock') lockUnlinked = true
        return result
      },
      sync: async (args, next, directory) => {
        if (directory.relativePath === '.wrkrs' && lockUnlinked && synced === 0) {
          synced += 1
          throw new FileSystemError('EIO', '.wrkrs', 'injected sync failure after lock removal')
        }
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
    expect(lock!.reason).toContain('not proven durable')
    expect(existsSync(path.join(root, '.wrkrs', '.lock'))).toBe(false)
    const journal = parseJournalDocument(
      readFileSync(path.join(root, '.wrkrs', '.journal.json'), 'utf8'),
    )
    expect(journal.ok).toBe(true)
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
