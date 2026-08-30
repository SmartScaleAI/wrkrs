import { existsSync, promises as fsp, readFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { FileSystemError } from '../../../src/core/ports.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import { createNodeFileSystem } from '../../../src/platform/filesystem.js'
import {
  createTestDependencies,
  createTestPorts,
  interceptFileSystem,
} from '../../helpers/ports.js'
import { createFixtureRepository, hashTree, makeTempDir, removeDir } from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

async function prepare(root: string, ports: InitPorts) {
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return prepared.value
}

function repo() {
  const root = createFixtureRepository('clean-repository', { commit: true })
  cleanup.push(root)
  return root
}

describe('journal durability', () => {
  it('syncs the staged bytes before the rename and the directory after it, and never writes the live journal directly', async () => {
    const root = repo()
    const sequence: string[] = []
    const fs = interceptFileSystem(createTestPorts().fs, {
      bound: {
        writeFileExclusive: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && args[0].startsWith('.journal.json')) {
            sequence.push(args[0] === '.journal.json' ? 'direct-write' : 'write-temp')
          }
          return next(...args)
        },
        rename: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && args[1] === '.journal.json')
            sequence.push('rename')
          return next(...args)
        },
        sync: async (args, next, directory) => {
          const result = await next(...args)
          if (directory.relativePath === '.wrkrs') sequence.push(`sync:${result}`)
          return result
        },
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('applied')
    expect(sequence).not.toContain('direct-write')
    // The lock is written and synced before the first journal write; only the
    // journal replacements are examined here.
    const persists = sequence
      .slice(sequence.indexOf('write-temp'))
      .join(' ')
      .split('write-temp')
      .filter((chunk) => chunk.trim() !== '')
    expect(persists.length).toBeGreaterThan(5)
    for (const chunk of persists) {
      expect(chunk.trim().startsWith('rename sync:synced')).toBe(true)
    }
  })

  it('fsyncs the temporary journal file before renaming it (Node level)', async () => {
    const directory = makeTempDir()
    cleanup.push(directory)
    const order: string[] = []
    const handle = await fsp.open(path.join(directory, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(handle) as { sync: () => Promise<void> }
    await handle.close()
    const realSync = prototype.sync
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: unknown) {
      order.push('sync')
      return realSync.call(this)
    })
    const realRename = fsp.rename
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      order.push(`rename:${String(from)}->${String(to)}`)
      return realRename(from, to)
    })
    const fs = createNodeFileSystem()
    await fs.withinDirectory(directory, '', async (bound) => {
      await bound.writeFileExclusive(
        '.journal.json.deadbeef.tmp',
        new TextEncoder().encode('{}\n'),
        0o644,
      )
      await bound.rename('.journal.json.deadbeef.tmp', '.journal.json')
      expect(await bound.sync()).toBe('synced')
    })
    expect(order).toEqual(['sync', 'rename:.journal.json.deadbeef.tmp->.journal.json', 'sync'])
    expect(readFileSync(path.join(directory, '.journal.json'), 'utf8')).toBe('{}\n')
  })

  it('aborts safely when the directory sync fails before any target is published', async () => {
    const root = repo()
    const before = hashTree(root)
    let failures = 0
    let journalRenamed = false
    const fs = interceptFileSystem(createTestPorts().fs, {
      bound: {
        rename: async (args, next) => {
          const result = await next(...args)
          if (args[1] === '.journal.json') journalRenamed = true
          return result
        },
        sync: async (args, next, directory) => {
          // Fail the sync that follows the first journal replacement.
          if (directory.relativePath === '.wrkrs' && journalRenamed && failures === 0) {
            failures += 1
            throw new FileSystemError('EIO', '.wrkrs', 'injected directory sync failure')
          }
          return next(...args)
        },
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(failures).toBe(1)
    expect(result.status).toBe('aborted')
    if (result.status === 'aborted') {
      expect(result.conflicts.map((conflict) => conflict.code)).toEqual([
        'PRECONDITION_JOURNAL_UNWRITABLE',
      ])
    }
    expect(hashTree(root)).toBe(before)
    expect(existsSync(path.join(root, '.wrkrs'))).toBe(false)
  })

  it('rolls back with correct in-memory state when the directory sync fails right after publication', async () => {
    const root = repo()
    const before = hashTree(root)
    let failures = 0
    const fs = interceptFileSystem(createTestPorts().fs, {
      bound: {
        sync: async (args, next, directory) => {
          if (directory.relativePath === '.claude/agents' && failures === 0) {
            failures += 1
            throw new FileSystemError(
              'EIO',
              directory.relativePath,
              'injected directory sync failure after link',
            )
          }
          return next(...args)
        },
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(failures).toBe(1)
    expect(result.status).toBe('rolled-back')
    expect(hashTree(root)).toBe(before)
  })

  it('records best-effort durability and warns when the platform cannot sync directories', async () => {
    const root = repo()
    const fs = interceptFileSystem(createTestPorts().fs, {
      bound: {
        sync: async () => 'unsupported' as const,
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('applied')
    if (result.status === 'applied') {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'TRANSACTION_DURABILITY_BEST_EFFORT',
      )
    }
  })

  it('never reports rolled-back when the final path verification cannot prove removal', async () => {
    const root = repo()
    const fs = interceptFileSystem(createTestPorts().fs, {
      bound: {
        writeFileExclusive: async (args, next) => {
          if (args[0].includes('wrkrs-qa-engineer')) throw new Error('injected write failure')
          return next(...args)
        },
        unlink: async (args, next, directory) => {
          if (
            directory.relativePath === '.claude/agents' &&
            args[0] === 'wrkrs-product-manager.md'
          ) {
            // Pretend the removal succeeded while the file stays on disk.
            return
          }
          return next(...args)
        },
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status === 'rollback-incomplete') {
      expect(result.retained.map((item) => item.path)).toContain(
        '.claude/agents/wrkrs-product-manager.md',
      )
    }
    expect(existsSync(path.join(root, '.claude', 'agents', 'wrkrs-product-manager.md'))).toBe(true)
  })
})
