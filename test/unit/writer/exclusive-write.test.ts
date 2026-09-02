import { existsSync, promises as fsp, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCheck } from '../../../src/check/check.js'
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
  fileMode,
  hashTree,
  makeTempDir,
  readTree,
  removeDir,
  type FixtureName,
} from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const AGENTS = '.claude/agents'
const AGENT = 'wrkrs-qa-engineer.md'
const STAGING = /^\.wrkrs-qa-engineer\.md\.wrkrs-[0-9a-f]{8}\.tmp$/
const JOURNAL_TEMP = /^\.journal\.json\.[0-9a-f]{8}\.tmp$/

type Matcher = (name: string, directory: string) => boolean

/**
 * Makes the real exclusive write fail *after* its entry exists: the O_EXCL
 * open runs for real, the first half of the bytes is written for real, and
 * then the handle's writeFile rejects with EIO. Armed only for names the
 * matcher selects. `afterFailure` runs inside the bound directory right after
 * the injected failure, before the transaction reacts.
 */
async function partialWriteFailure(
  match: Matcher,
  extra: FileSystemInterceptors['bound'] = {},
  afterFailure?: (name: string) => void,
) {
  const probeDirectory = makeTempDir()
  cleanup.push(probeDirectory)
  const probe = await fsp.open(path.join(probeDirectory, 'probe'), 'w')
  const prototype = Object.getPrototypeOf(probe) as {
    writeFile: (data: Uint8Array, ...rest: unknown[]) => Promise<void>
  }
  await probe.close()
  const realWriteFile = prototype.writeFile
  const state = { armed: false, hits: 0 }
  vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
    this: unknown,
    data: Uint8Array,
    ...rest: unknown[]
  ) {
    if (state.armed) {
      state.armed = false
      state.hits += 1
      await realWriteFile.call(this, data.subarray(0, Math.floor(data.byteLength / 2)), ...rest)
      throw Object.assign(new Error('EIO: injected write failure'), { code: 'EIO' })
    }
    return realWriteFile.call(this, data, ...rest)
  })
  const fs = interceptFileSystem(createTestPorts().fs, {
    bound: {
      ...extra,
      writeFileExclusive: async (args, next, directory) => {
        if (match(args[0], directory.relativePath)) state.armed = true
        try {
          return await next(...args)
        } catch (error) {
          if (afterFailure && match(args[0], directory.relativePath)) afterFailure(args[0])
          throw error
        } finally {
          state.armed = false
        }
      },
    },
  })
  return { fs, hits: () => state.hits }
}

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

function stagingEntries(root: string): string[] {
  return readTree(root)
    .map((entry) => entry.path)
    .filter((entry) => STAGING.test(path.posix.basename(entry)))
}

describe('exclusive writes that fail after the entry was created', () => {
  // Conservative behavior recorded in decisions.md A-019: a partial staging
  // entry is never deleted, because no portable primitive proves the current
  // directory entry is still the file wrkrs created. Earlier rounds deleted
  // it when its bytes were a prefix of the planned bytes; that inference was
  // removed as unsound.
  it.each(['clean-repository', 'existing-claude-repository'] as FixtureName[])(
    'retains a partially written staging file, reports its exact path, and removes everything else (%s)',
    async (fixture) => {
      const root = repo(fixture)
      const injected = await partialWriteFailure(
        (name, dir) => dir === AGENTS && STAGING.test(name),
      )
      const ports = createTestPorts({ fs: injected.fs })
      const prepared = await prepare(root, ports)
      const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
      expect(injected.hits()).toBe(1)
      expect(result.status).toBe('rollback-incomplete')
      if (result.status !== 'rollback-incomplete') return
      const staging = stagingEntries(root)
      expect(staging).toHaveLength(1)
      expect(result.retained.map((item) => item.path)).toContain(staging[0])
      const retainedEntry = result.retained.find((item) => item.path === staging[0])
      expect(retainedEntry!.reason).toContain('cannot prove')
      const planned = prepared.plan.operations.find(
        (operation) => operation.path === `${AGENTS}/${AGENT}`,
      )!
      expect(readFileSync(path.join(root, ...staging[0]!.split('/'))).byteLength).toBeLessThan(
        planned.proposedSize!,
      )
      // The target was never published and every other generated file is gone.
      expect(existsSync(path.join(root, ...AGENTS.split('/'), AGENT))).toBe(false)
      expect(
        readTree(root).filter(
          (entry) =>
            entry.path.includes('wrkrs-') && !STAGING.test(path.posix.basename(entry.path)),
        ),
      ).toEqual([])
      const journal = parseJournalDocument(
        readFileSync(path.join(root, '.wrkrs', '.journal.json'), 'utf8'),
      )
      expect(journal.ok && journal.value.status).toBe('rollback-incomplete')
      expect(
        journal.ok &&
          journal.value.operations.find((op) => op.path === `${AGENTS}/${AGENT}`)?.stagingPath,
      ).toBe(staging[0])
    },
  )

  it('preserves an external replacement of the partial staging entry byte-for-byte and mode-for-mode', async () => {
    const root = repo('existing-claude-repository')
    let replaced: string | null = null
    const injected = await partialWriteFailure(
      (name, dir) => dir === AGENTS && STAGING.test(name),
      {},
      (name) => {
        // Another process replaces the partial entry (relative to the bound
        // directory) with its own empty file before rollback runs.
        rmSync(name)
        writeFileSync(name, '', { mode: 0o600 })
        replaced = name
      },
    )
    const ports = createTestPorts({ fs: injected.fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(injected.hits()).toBe(1)
    expect(replaced).not.toBeNull()
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    const stagingPath = `${AGENTS}/${replaced!}`
    expect(result.retained.map((item) => item.path)).toContain(stagingPath)
    const external = path.join(root, ...stagingPath.split('/'))
    expect(existsSync(external)).toBe(true)
    expect(readFileSync(external, 'utf8')).toBe('')
    expect(fileMode(external)).toBe(0o600)
    expect(statSync(external).size).toBe(0)
  })

  it('never returns plain aborted while a partially written lock remains', async () => {
    const root = repo()
    const before = hashTree(root)
    const injected = await partialWriteFailure((name, dir) => dir === '.wrkrs' && name === '.lock')
    const ports = createTestPorts({ fs: injected.fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(injected.hits()).toBe(1)
    const lockPath = path.join(root, '.wrkrs', '.lock')
    if (result.status === 'aborted') {
      expect(existsSync(lockPath)).toBe(false)
      expect(existsSync(path.join(root, '.wrkrs'))).toBe(false)
      expect(hashTree(root)).toBe(before)
    } else {
      expect(result.status).toBe('rollback-incomplete')
      if (result.status === 'rollback-incomplete') {
        expect(result.retained.map((item) => item.path)).toContain('.wrkrs/.lock')
      }
      expect(existsSync(lockPath)).toBe(true)
    }
  })

  it('reports the exact lock path and keeps a recovery journal when the lock cannot be removed', async () => {
    const root = repo()
    const injected = await partialWriteFailure(
      (name, dir) => dir === '.wrkrs' && name === '.lock',
      {
        unlink: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && args[0] === '.lock') {
            throw new FileSystemError('EPERM', args[0], 'injected: cannot remove lock')
          }
          return next(...args)
        },
      },
    )
    const ports = createTestPorts({ fs: injected.fs })
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
    const deps = createTestDependencies()
    const report = await runCheck(
      {
        cwd: root,
        wrkrsVersion: deps.wrkrsVersion,
        adapters: deps.adapters,
        providers: deps.providers,
      },
      createTestPorts(),
    )
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'TRANSACTION_INTERRUPTED',
    )
  })

  it('removes a journal temporary whose write failed after creation and leaves the live journal valid', async () => {
    const root = repo()
    const before = hashTree(root)
    let seen = 0
    const injected = await partialWriteFailure((name, dir) => {
      if (dir !== '.wrkrs' || !JOURNAL_TEMP.test(name)) return false
      seen += 1
      return seen === 4
    })
    const ports = createTestPorts({ fs: injected.fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(injected.hits()).toBe(1)
    expect(result.status).toBe('rolled-back')
    expect(readTree(root).some((entry) => JOURNAL_TEMP.test(path.posix.basename(entry.path)))).toBe(
      false,
    )
    expect(hashTree(root)).toBe(before)
  })

  it('reports the exact journal temporary when it can never be removed, without duplicate entries', async () => {
    const root = repo()
    let seen = 0
    const injected = await partialWriteFailure(
      (name, dir) => {
        if (dir !== '.wrkrs' || !JOURNAL_TEMP.test(name)) return false
        seen += 1
        return seen === 4
      },
      {
        unlink: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && JOURNAL_TEMP.test(args[0])) {
            throw new FileSystemError('EPERM', args[0], 'injected: cannot remove journal temp')
          }
          return next(...args)
        },
      },
    )
    const ports = createTestPorts({ fs: injected.fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rollback-incomplete')
    const temps = readTree(root)
      .map((entry) => entry.path)
      .filter((entry) => JOURNAL_TEMP.test(path.posix.basename(entry)))
    expect(temps).toHaveLength(1)
    if (result.status === 'rollback-incomplete') {
      const paths = result.retained.map((item) => item.path)
      expect(paths).toContain(temps[0])
      expect(new Set(paths).size).toBe(paths.length)
    }
    const live = parseJournalDocument(
      readFileSync(path.join(root, '.wrkrs', '.journal.json'), 'utf8'),
    )
    expect(live.ok).toBe(true)
  })

  it('preserves EEXIST entries at the staging, lock, and journal-temporary names byte-for-byte and mode-for-mode', async () => {
    // Staging name owned by another process.
    const root = repo('existing-claude-repository')
    const foreignStaging = path.join(
      root,
      '.claude',
      'agents',
      '.wrkrs-qa-engineer.md.wrkrs-00000000.tmp',
    )
    await fsp.writeFile(foreignStaging, 'foreign staging\n', { mode: 0o600 })
    const before = readTree(root)
    const ports = createTestPorts()
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rolled-back')
    if (result.status === 'rolled-back') {
      expect(result.conflict?.code).toBe('PRECONDITION_STAGING_NAME_TAKEN')
    }
    expect(readFileSync(foreignStaging, 'utf8')).toBe('foreign staging\n')
    expect(fileMode(foreignStaging)).toBe(0o600)
    expect(readTree(root)).toEqual(before)

    // Lock and journal-temporary names owned by another process (created inside our .wrkrs).
    for (const [name, matcher] of [
      ['.lock', (candidate: string) => candidate === '.lock'],
      ['journal temp', (candidate: string) => JOURNAL_TEMP.test(candidate)],
    ] as const) {
      const other = repo()
      let foreign: string | null = null
      const fs = interceptFileSystem(createTestPorts().fs, {
        bound: {
          writeFileExclusive: async (args, next, directory) => {
            if (directory.relativePath === '.wrkrs' && matcher(args[0]) && foreign === null) {
              foreign = path.join(other, '.wrkrs', args[0])
              await fsp.writeFile(args[0], `foreign ${name}\n`, { mode: 0o600 })
            }
            return next(...args)
          },
        },
      })
      const otherPorts = createTestPorts({ fs })
      const otherPrepared = await prepare(other, otherPorts)
      const otherResult = await applyPreparedInit(
        otherPrepared,
        createTestDependencies(),
        otherPorts,
      )
      expect(foreign).not.toBeNull()
      expect(readFileSync(foreign!, 'utf8')).toBe(`foreign ${name}\n`)
      expect(fileMode(foreign!)).toBe(0o600)
      expect(['aborted', 'rollback-incomplete']).toContain(otherResult.status)
      if (otherResult.status === 'rollback-incomplete') {
        expect(otherResult.retained.map((item) => item.path)).not.toContain(
          path.relative(other, foreign!),
        )
      }
      expect(readTree(other).filter((entry) => entry.path.startsWith('.claude'))).toEqual([])
    }
  })

  it('cannot report rolled-back while a staging name still exists', async () => {
    const root = repo('existing-claude-repository')
    const injected = await partialWriteFailure(
      (name, dir) => dir === AGENTS && STAGING.test(name),
      {
        unlink: async (args, next, directory) => {
          // Pretend a removal succeeded while the entry stays on disk.
          if (directory.relativePath === AGENTS && STAGING.test(args[0])) return
          return next(...args)
        },
      },
    )
    const ports = createTestPorts({ fs: injected.fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rollback-incomplete')
    expect(stagingEntries(root)).toHaveLength(1)
    if (result.status === 'rollback-incomplete') {
      expect(result.retained.map((item) => item.path)).toContain(stagingEntries(root)[0])
    }
    expect(statSync(path.join(root, ...stagingEntries(root)[0]!.split('/'))).isFile()).toBe(true)
  })
})
