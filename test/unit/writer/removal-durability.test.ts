import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseJournalDocument } from '../../../src/config/load.js'
import { FileSystemError } from '../../../src/core/ports.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import { createJournal, persistJournal } from '../../../src/writer/journal.js'
import {
  createTestDependencies,
  createTestPorts,
  interceptFileSystem,
  type FileSystemInterceptors,
} from '../../helpers/ports.js'
import {
  createFixtureRepository,
  hashTree,
  removeDir,
  type FixtureName,
} from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const AGENTS = '.claude/agents'
const AGENT = `${AGENTS}/wrkrs-qa-engineer.md`
const STAGING = /^\.wrkrs-qa-engineer\.md\.wrkrs-[0-9a-f]{8}\.tmp$/

interface JournalView {
  status: string
  durability: string
  operations: { path: string; status: string; stagingPath: string | null }[]
}

/** Event log across bound operations, in call order, plus the journal state each persist writes. */
function recorder(extra: FileSystemInterceptors['bound'] = {}) {
  const events: string[] = []
  const fs = interceptFileSystem(createTestPorts().fs, {
    bound: {
      unlink: async (args, next, directory) => {
        const result = await (extra.unlink ? extra.unlink(args, next, directory) : next(...args))
        events.push(`unlink ${directory.relativePath}/${args[0]}`)
        return result
      },
      removeDirectory: async (args, next, directory) => {
        await next(...args)
        events.push(`rmdir ${directory.relativePath}/${args[0]}`)
      },
      lstat: async (args, next, directory) => {
        const result = await next(...args)
        events.push(`lstat ${directory.relativePath}/${args[0]}=${result ? result.kind : 'absent'}`)
        return result
      },
      sync: async (args, next, directory) => {
        const result = await (extra.sync ? extra.sync(args, next, directory) : next(...args))
        events.push(`sync ${directory.relativePath}=${result}`)
        return result
      },
      rename: async (args, next) => {
        if (args[1] === '.journal.json') {
          const pending = JSON.parse(readFileSync(args[0], 'utf8')) as JournalView
          events.push(
            `journal ${JSON.stringify(pending.operations.map((op) => [op.path, op.status, op.stagingPath]))} status=${pending.status}`,
          )
        }
        return next(...args)
      },
      writeFileExclusive: async (args, next, directory) =>
        extra.writeFileExclusive ? extra.writeFileExclusive(args, next, directory) : next(...args),
    },
  })
  return { fs, events }
}

async function prepare(root: string, ports: InitPorts) {
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return prepared.value
}

function repo(fixture: FixtureName = 'existing-claude-repository'): string {
  const root = createFixtureRepository(fixture, { commit: true })
  cleanup.push(root)
  return root
}

function indexOf(events: string[], predicate: (event: string) => boolean, from = 0): number {
  const index = events.slice(from).findIndex(predicate)
  return index === -1 ? -1 : index + from
}

describe('removal durability ordering', () => {
  it('after staging cleanup: unlink, absence check, directory sync, then the journal forgets the staging path', async () => {
    const root = repo()
    const { fs, events } = recorder()
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    expect((await applyPreparedInit(prepared, createTestDependencies(), ports)).status).toBe(
      'applied',
    )
    const unlink = indexOf(
      events,
      (event) =>
        event.startsWith(`unlink ${AGENTS}/`) && STAGING.test(event.split('/').pop() ?? ''),
    )
    expect(unlink).toBeGreaterThan(-1)
    const absence = indexOf(
      events,
      (event) =>
        event.startsWith(`lstat ${AGENTS}/`) &&
        event.endsWith('=absent') &&
        STAGING.test(event.split('/').pop()?.split('=')[0] ?? ''),
      unlink,
    )
    const sync = indexOf(events, (event) => event === `sync ${AGENTS}=synced`, absence)
    const forget = indexOf(
      events,
      (event) => event.startsWith('journal ') && event.includes(`["${AGENT}","published",null]`),
      sync,
    )
    expect(unlink).toBeLessThan(absence)
    expect(absence).toBeLessThan(sync)
    expect(sync).toBeLessThan(forget)
    // No journal write cleared the staging path before the sync.
    const early = events
      .slice(0, sync)
      .filter(
        (event) => event.startsWith('journal ') && event.includes(`["${AGENT}","published",null]`),
      )
    expect(early).toEqual([])
  })

  it('rollback of a published target: unlink, absence check, directory sync, then reverted', async () => {
    const root = repo()
    const { fs, events } = recorder({
      writeFileExclusive: async (args, next) => {
        if (args[0].includes('wrkrs-software-engineer')) throw new Error('injected write failure')
        return next(...args)
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rolled-back')
    const target = `${AGENTS}/wrkrs-product-manager.md`
    const rollbackStart = indexOf(
      events,
      (event) => event.startsWith('journal ') && event.includes('status=rolling-back'),
    )
    const unlink = indexOf(events, (event) => event === `unlink ${target}`, rollbackStart)
    const absence = indexOf(events, (event) => event === `lstat ${target}=absent`, unlink)
    const sync = indexOf(events, (event) => event === `sync ${AGENTS}=synced`, absence)
    const reverted = indexOf(
      events,
      (event) => event.startsWith('journal ') && event.includes(`["${target}","reverted",null]`),
      sync,
    )
    expect(unlink).toBeGreaterThan(rollbackStart)
    expect(absence).toBeGreaterThan(unlink)
    expect(sync).toBeGreaterThan(absence)
    expect(reverted).toBeGreaterThan(sync)
  })

  it('rollback of a staging file follows the same order', async () => {
    const root = repo()
    let failed = false
    const { fs, events } = recorder({
      sync: async (args, next, directory) => {
        // Fail the directory sync that follows publication of the qa agent so the
        // staging file is still recorded and must be rolled back.
        if (
          directory.relativePath === AGENTS &&
          !failed &&
          events.some((event) => event.includes(`["${AGENT}","staged"`))
        ) {
          failed = true
          throw new FileSystemError('EIO', AGENTS, 'injected sync failure after publication')
        }
        return next(...args)
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(failed).toBe(true)
    expect(result.status).toBe('rolled-back')
    const rollbackStart = indexOf(
      events,
      (event) => event.startsWith('journal ') && event.includes('status=rolling-back'),
    )
    const unlink = indexOf(
      events,
      (event) =>
        event.startsWith(`unlink ${AGENTS}/`) && STAGING.test(event.split('/').pop() ?? ''),
      rollbackStart,
    )
    const absence = indexOf(
      events,
      (event) =>
        event.startsWith(`lstat ${AGENTS}/`) &&
        event.endsWith('=absent') &&
        STAGING.test(event.split('/').pop()?.split('=')[0] ?? ''),
      unlink,
    )
    const sync = indexOf(events, (event) => event === `sync ${AGENTS}=synced`, absence)
    const reverted = indexOf(
      events,
      (event) => event.startsWith('journal ') && event.includes(`["${AGENT}","reverted",`),
      sync,
    )
    expect(unlink).toBeGreaterThan(rollbackStart)
    expect(absence).toBeGreaterThan(unlink)
    expect(sync).toBeGreaterThan(absence)
    expect(reverted).toBeGreaterThan(sync)
  })

  it('generated-directory removal is verified and synced before it is recorded as reverted', async () => {
    const root = repo('clean-repository')
    const { fs, events } = recorder({
      writeFileExclusive: async (args, next) => {
        if (args[0].includes('wrkrs-product-designer')) throw new Error('injected write failure')
        return next(...args)
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rolled-back')
    const rmdir = indexOf(events, (event) => event === `rmdir .claude/agents`)
    const absence = indexOf(events, (event) => event === `lstat .claude/agents=absent`, rmdir)
    const sync = indexOf(events, (event) => event === `sync .claude=synced`, absence)
    const reverted = indexOf(
      events,
      (event) =>
        event.startsWith('journal ') && event.includes(`[".claude/agents","reverted",null]`),
      sync,
    )
    expect(rmdir).toBeGreaterThan(-1)
    expect(absence).toBeGreaterThan(rmdir)
    expect(sync).toBeGreaterThan(absence)
    expect(reverted).toBeGreaterThan(sync)
  })

  it('an EIO on the directory sync after a rollback unlink yields rollback-incomplete, even though the file is absent', async () => {
    const root = repo()
    let rollingBack = false
    let failures = 0
    const { fs } = recorder({
      writeFileExclusive: async (args, next) => {
        if (args[0].includes('wrkrs-software-engineer')) {
          rollingBack = true
          throw new Error('injected write failure')
        }
        return next(...args)
      },
      sync: async (args, next, directory) => {
        if (rollingBack && directory.relativePath === AGENTS && failures === 0) {
          failures += 1
          throw new FileSystemError('EIO', AGENTS, 'injected sync failure during rollback')
        }
        return next(...args)
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(failures).toBe(1)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    const unproven = result.retained.find((item) => item.reason.includes('not proven durable'))
    expect(unproven).toBeDefined()
    expect(unproven!.path.startsWith(`${AGENTS}/`)).toBe(true)
    // Current absence is deliberately not treated as proof of durable deletion.
    expect(existsSync(path.join(root, ...unproven!.path.split('/')))).toBe(false)
    const journal = parseJournalDocument(
      readFileSync(path.join(root, '.wrkrs', '.journal.json'), 'utf8'),
    )
    expect(journal.ok && journal.value.status).toBe('rollback-incomplete')
  })

  it('an EIO during bookkeeping cleanup is surfaced and strict durability is not claimed', async () => {
    const root = repo('clean-repository')
    let committed = false
    let syncsAfterCommit = 0
    let failures = 0
    const { fs } = recorder({
      sync: async (args, next, directory) => {
        // The first .wrkrs sync after the committed state is the journal
        // replacement's own; the second belongs to bookkeeping cleanup.
        if (committed && directory.relativePath === '.wrkrs') {
          syncsAfterCommit += 1
          if (syncsAfterCommit === 2 && failures === 0) {
            failures += 1
            throw new FileSystemError(
              'EIO',
              '.wrkrs',
              'injected sync failure during bookkeeping cleanup',
            )
          }
        }
        return next(...args)
      },
    })
    const watched = interceptFileSystem(fs, {
      bound: {
        rename: async (args, next) => {
          if (args[1] === '.journal.json') {
            const pending = JSON.parse(readFileSync(args[0], 'utf8')) as JournalView
            if (pending.status === 'committed') committed = true
          }
          return next(...args)
        },
      },
    })
    const ports = createTestPorts({ fs: watched })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(failures).toBe(1)
    expect(result.status).toBe('applied')
    if (result.status !== 'applied') return
    expect(result.durability).toBe('best-effort')
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code)
    expect(codes).toContain('TRANSACTION_BOOKKEEPING_DURABILITY_UNPROVEN')
    expect(codes).toContain('TRANSACTION_DURABILITY_BEST_EFFORT')
  })

  it('a retained journal serializes durability best-effort when a sync was unsupported', async () => {
    const root = repo()
    const { fs } = recorder({
      sync: async (args, next, directory) =>
        directory.relativePath === AGENTS ? 'unsupported' : next(...args),
      unlink: async (args, next, directory) => {
        if (directory.relativePath === AGENTS && args[0] === 'wrkrs-product-manager.md') {
          throw new FileSystemError('EPERM', args[0], 'injected: cannot remove')
        }
        return next(...args)
      },
      writeFileExclusive: async (args, next) => {
        if (args[0].includes('wrkrs-software-engineer')) throw new Error('injected write failure')
        return next(...args)
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rollback-incomplete')
    const journal = parseJournalDocument(
      readFileSync(path.join(root, '.wrkrs', '.journal.json'), 'utf8'),
    )
    expect(journal.ok && journal.value.durability).toBe('best-effort')
    expect(journal.ok && journal.value.status).toBe('rollback-incomplete')
  })

  it('persistJournal rewrites the journal so the serialized durability matches an unsupported directory sync', async () => {
    const root = repo('clean-repository')
    const { fs, events } = recorder({ sync: async () => 'unsupported' as const })
    await fs.withinDirectory(root, '', (bound) => bound.makeDirectory('.wrkrs', 0o755))
    const journal = createJournal({
      transactionId: '00000000-0000-4000-8000-00000000cafe',
      planDigest: 'sha256:' + 'a'.repeat(64),
      startedAt: '2026-08-30T00:00:00.000Z',
      operations: [],
    })
    const persisted = await persistJournal(fs, root, journal, createTestPorts().clock)
    expect(persisted.durability).toBe('best-effort')
    const onDisk = parseJournalDocument(
      readFileSync(path.join(root, '.wrkrs', '.journal.json'), 'utf8'),
    )
    expect(onDisk.ok && onDisk.value.durability).toBe('best-effort')
    expect(events.filter((event) => event.startsWith('journal ')).length).toBe(2)
    expect(hashTree(root)).toBeDefined()
  })
})
