import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileSystemError } from '../../../src/core/ports.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import {
  createTestDependencies,
  createTestPorts,
  interceptFileSystem,
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

const AGENT = '.claude/agents/wrkrs-qa-engineer.md'
const FIXTURES: FixtureName[] = ['clean-repository', 'existing-claude-repository']

interface JournalView {
  status: string
  operations: { path: string; status: string }[]
}

function journalFailure(): FileSystemError {
  return new FileSystemError('EIO', '.wrkrs/.journal.json', 'injected journal persistence failure')
}

/**
 * Fails the journal replacement (the rename of the staged journal over the
 * live journal) when the content about to be persisted matches `when`.
 */
function failJournalWhen(
  when: (journal: JournalView, persistCount: number) => boolean,
  options: { once?: boolean } = {},
) {
  let persistCount = 0
  let failed = 0
  const fs = interceptFileSystem(createTestPorts().fs, {
    rename: async (args, next) => {
      if (args[1].endsWith('.journal.json')) {
        persistCount += 1
        const pending = JSON.parse(readFileSync(args[0], 'utf8')) as JournalView
        if (when(pending, persistCount) && (!options.once || failed === 0)) {
          failed += 1
          throw journalFailure()
        }
      }
      return next(...args)
    },
  })
  return { fs, failures: () => failed }
}

async function prepare(root: string, ports: InitPorts) {
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return prepared.value
}

function opStatus(journal: JournalView, operationPath: string): string | undefined {
  return journal.operations.find((operation) => operation.path === operationPath)?.status
}

describe.each(FIXTURES)('journal persistence failures in %s', (fixture) => {
  function repo(): string {
    const root = createFixtureRepository(fixture, { commit: true })
    cleanup.push(root)
    return root
  }

  it('aborts cleanly when the very first journal write fails (before any target exists)', async () => {
    const root = repo()
    const before = hashTree(root)
    const { fs, failures } = failJournalWhen((_journal, count) => count === 1)
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(failures()).toBe(1)
    expect(result.status).toBe('aborted')
    if (result.status === 'aborted') {
      expect(result.conflicts.map((conflict) => conflict.code)).toEqual([
        'PRECONDITION_JOURNAL_UNWRITABLE',
      ])
    }
    expect(hashTree(root)).toBe(before)
  })

  it('rolls back when the journal fails before any target is published', async () => {
    const root = repo()
    const before = hashTree(root)
    const { fs } = failJournalWhen(
      (journal) => journal.status === 'applying' && opStatus(journal, AGENT) === 'staged',
      { once: true },
    )
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rolled-back')
    expect(hashTree(root)).toBe(before)
  })

  it('rolls back and removes the target when the journal fails immediately after publication', async () => {
    const root = repo()
    const before = hashTree(root)
    const { fs, failures } = failJournalWhen(
      (journal) => opStatus(journal, AGENT) === 'published',
      { once: true },
    )
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(failures()).toBe(1)
    expect(result.status).toBe('rolled-back')
    expect(existsSync(path.join(root, ...AGENT.split('/')))).toBe(false)
    expect(readTree(root).filter((entry) => entry.path.includes('wrkrs-'))).toEqual([])
    expect(hashTree(root)).toBe(before)
  })

  it('rolls back and removes the target when the journal fails after verification but before applied is persisted', async () => {
    const root = repo()
    const before = hashTree(root)
    const { fs, failures } = failJournalWhen((journal) => opStatus(journal, AGENT) === 'applied', {
      once: true,
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(failures()).toBe(1)
    expect(result.status).toBe('rolled-back')
    expect(existsSync(path.join(root, ...AGENT.split('/')))).toBe(false)
    expect(hashTree(root)).toBe(before)
  })

  it('completes rollback from in-memory state when every journal update during rollback fails', async () => {
    const root = repo()
    const before = hashTree(root)
    const journals = failJournalWhen(
      (journal) => journal.status === 'rolling-back' || journal.status === 'rolled-back',
    )
    const fs = interceptFileSystem(journals.fs, {
      writeFileExclusive: async (args, next) => {
        if (args[0].includes('wrkrs-software-engineer')) throw new Error('injected write failure')
        return next(...args)
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(journals.failures()).toBeGreaterThan(0)
    expect(result.status).toBe('rolled-back')
    expect(hashTree(root)).toBe(before)
    expect(existsSync(path.join(root, '.wrkrs'))).toBe(
      fixture === 'existing-claude-repository' ? false : false,
    )
  })

  it('never reports rolled-back while a generated file remains, and names the exact file', async () => {
    const root = repo()
    const fs = interceptFileSystem(createTestPorts().fs, {
      writeFileExclusive: async (args, next) => {
        if (args[0].includes('wrkrs-software-engineer')) throw new Error('injected write failure')
        return next(...args)
      },
      unlink: async (args, next) => {
        if (args[0].endsWith(AGENT.split('/').join(path.sep))) {
          throw new FileSystemError('EPERM', args[0], 'injected: cannot remove the agent')
        }
        return next(...args)
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    expect(result.retained.map((item) => item.path)).toContain(AGENT)
    expect(existsSync(path.join(root, ...AGENT.split('/')))).toBe(true)
    const journal = JSON.parse(
      readFileSync(path.join(root, '.wrkrs', '.journal.json'), 'utf8'),
    ) as JournalView
    expect(journal.status).toBe('rollback-incomplete')
    expect(opStatus(journal, AGENT)).toBe('retained')
  })
})

describe('journal durability', () => {
  it('replaces the journal through a staged temporary file so a failed write never truncates the record', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const seen: string[] = []
    let sabotaged = false
    const fs = interceptFileSystem(createTestPorts().fs, {
      writeFileExclusive: async (args, next) => {
        if (args[0].includes('.journal.json') && args[0].endsWith('.tmp')) {
          seen.push('staged')
          const live = args[0].replace(/\.[0-9a-f]{8}\.tmp$/, '')
          if (existsSync(live) && !sabotaged) {
            sabotaged = true
            const before = readFileSync(live, 'utf8')
            try {
              throw new FileSystemError(
                'ENOSPC',
                args[0],
                'injected: no space for the staged journal',
              )
            } finally {
              expect(readFileSync(live, 'utf8')).toBe(before)
            }
          }
        }
        if (args[0].includes('.journal.json') && !args[0].endsWith('.tmp')) seen.push('direct')
        return next(...args)
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(seen).not.toContain('direct')
    expect(seen.filter((item) => item === 'staged').length).toBeGreaterThan(1)
    expect(result.status).toBe('rolled-back')
    expect(existsSync(path.join(root, '.wrkrs'))).toBe(false)
  })
})
