import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runCheck } from '../../../src/check/check.js'
import { createDiagnostic } from '../../../src/core/diagnostics.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import { sha256 } from '../../../src/platform/hash.js'
import { applyPlan } from '../../../src/writer/transaction.js'
import {
  createTestDependencies,
  createTestPorts,
  interceptFileSystem,
} from '../../helpers/ports.js'
import { createFixtureRepository, hashTree, readTree, removeDir } from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

async function prepare(root: string, ports: InitPorts = createTestPorts()) {
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return prepared.value
}

function repo(): string {
  const root = createFixtureRepository('clean-repository', { commit: true })
  cleanup.push(root)
  return root
}

describe('transactional apply', () => {
  it('applies a clean plan, records exact hashes, and leaves no journal or lock', async () => {
    const root = repo()
    const ports = createTestPorts()
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('applied')
    if (result.status !== 'applied') return
    expect(result.appliedPaths.at(-1)).toBe('.wrkrs/manifest.json')
    expect(result.appliedPaths.slice(0, -1)).toEqual([...result.appliedPaths.slice(0, -1)].sort())

    const manifest = JSON.parse(
      readFileSync(path.join(root, '.wrkrs', 'manifest.json'), 'utf8'),
    ) as {
      installationId: string
      entries: { path: string; lastAppliedHash: string; management: string }[]
      createdDirectories: string[]
    }
    expect(manifest.installationId).toBe(prepared.plan.installationId)
    expect(manifest.entries.map((entry) => entry.path)).not.toContain('.wrkrs/manifest.json')
    for (const entry of manifest.entries) {
      const bytes = readFileSync(path.join(root, ...entry.path.split('/')))
      expect(sha256(bytes)).toBe(entry.lastAppliedHash)
      expect(bytes.at(-1)).toBe(0x0a)
      expect(readTree(root).find((item) => item.path === entry.path)?.mode).toBe(0o644)
    }
    expect(existsSync(path.join(root, '.wrkrs', '.journal.json'))).toBe(false)
    expect(existsSync(path.join(root, '.wrkrs', '.lock'))).toBe(false)
    const check = await runCheck(
      {
        cwd: root,
        wrkrsVersion: '0.1.0-test',
        adapters: createTestDependencies().adapters,
        providers: createTestDependencies().providers,
      },
      ports,
    )
    expect(check.ok).toBe(true)
  })

  it('aborts before the first mutation when a precondition changed after planning', async () => {
    const root = repo()
    const ports = createTestPorts()
    const prepared = await prepare(root, ports)
    mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
    writeFileSync(path.join(root, '.claude', 'agents', 'wrkrs-qa-engineer.md'), 'late arrival\n')
    const before = hashTree(root)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('aborted')
    if (result.status === 'aborted') {
      expect(result.conflicts.map((conflict) => conflict.code)).toContain(
        'PRECONDITION_TARGET_CHANGED',
      )
    }
    expect(hashTree(root)).toBe(before)
    expect(existsSync(path.join(root, '.wrkrs'))).toBe(false)
  })

  it('refuses to run when another installation holds the lock', async () => {
    const root = repo()
    const inner = createTestPorts().fs
    const fs = interceptFileSystem(inner, {
      bound: {
        writeFileExclusive: async (args, next) => {
          if (args[0] === '.lock') {
            await next('.lock', new TextEncoder().encode('{"transactionId":"competitor"}\n'), 0o644)
          }
          return next(...args)
        },
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('aborted')
    if (result.status === 'aborted') {
      expect(result.conflicts.map((conflict) => conflict.code)).toEqual(['OWNERSHIP_LOCK_PRESENT'])
    }
    expect(
      readTree(root)
        .map((entry) => entry.path)
        .filter((p) => p.startsWith('.claude')),
    ).toEqual([])
    expect(existsSync(path.join(root, '.wrkrs', '.journal.json'))).toBe(false)
  })

  it('aborts when an interrupted journal is present', async () => {
    const root = repo()
    const ports = createTestPorts()
    const prepared = await prepare(root, ports)
    mkdirSync(path.join(root, '.wrkrs'))
    writeFileSync(path.join(root, '.wrkrs', '.journal.json'), '{"schemaVersion":1}')
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('aborted')
    if (result.status === 'aborted') {
      expect(result.conflicts[0]?.code).toBe('OWNERSHIP_TRANSACTION_INTERRUPTED')
    }
  })

  it('rolls back in reverse after an injected write failure and restores the exact tree', async () => {
    const root = repo()
    const before = hashTree(root)
    let writes = 0
    const fs = interceptFileSystem(createTestPorts().fs, {
      bound: {
        writeFileExclusive: async (args, next) => {
          if (args[0].includes('wrkrs-qa-engineer')) {
            throw new Error('injected disk failure')
          }
          writes += 1
          return next(...args)
        },
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rolled-back')
    if (result.status === 'rolled-back') expect(result.failure).toContain('injected disk failure')
    expect(writes).toBeGreaterThanOrEqual(3)
    expect(hashTree(root)).toBe(before)
    expect(existsSync(path.join(root, '.wrkrs'))).toBe(false)
    expect(existsSync(path.join(root, '.claude'))).toBe(false)
  })

  it('detects a corrupted write through post-write verification and rolls back', async () => {
    const root = repo()
    const before = hashTree(root)
    const fs = interceptFileSystem(createTestPorts().fs, {
      bound: {
        linkExclusive: async (args, next, directory) => {
          await next(...args)
          if (args[1] === 'schema.json') {
            appendFileSync(
              path.join(root, ...directory.relativePath.split('/'), args[1]),
              '/* corrupted */',
            )
          }
        },
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    // The published bytes no longer match what wrkrs wrote, which is
    // indistinguishable from an external edit: the file must be retained and
    // reported, and everything else reverted.
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    expect(result.failure).toContain('Post-write verification failed')
    expect(result.retained.map((item) => item.path)).toContain('.wrkrs/schema.json')
    expect(readFileSync(path.join(root, '.wrkrs', 'schema.json'), 'utf8')).toContain(
      '/* corrupted */',
    )
    const remaining = readTree(root)
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.path)
      .filter((entry) => entry.startsWith('.wrkrs') || entry.startsWith('.claude'))
    expect(remaining).toEqual(['.wrkrs/.journal.json', '.wrkrs/schema.json'])
    expect(before).not.toBe(hashTree(root))
  })

  it('rolls back when post-apply validation reports an error', async () => {
    const root = repo()
    const before = hashTree(root)
    const ports = createTestPorts()
    const prepared = await prepare(root, ports)
    const result = await applyPlan(
      {
        plan: prepared.plan,
        validate: async () => [
          createDiagnostic('TEST_INJECTED_FAILURE', 'error', 'injected validation failure'),
        ],
      },
      ports,
    )
    expect(result.status).toBe('rolled-back')
    if (result.status === 'rolled-back') {
      expect(result.failure).toContain('TEST_INJECTED_FAILURE')
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'TEST_INJECTED_FAILURE',
      )
    }
    expect(hashTree(root)).toBe(before)
  })

  it('never deletes a file that was externally modified after wrkrs wrote it', async () => {
    const root = repo()
    const edited = path.join(root, '.claude', 'agents', 'wrkrs-product-designer.md')
    const fs = interceptFileSystem(createTestPorts().fs, {
      bound: {
        writeFileExclusive: async (args, next) => {
          if (args[0].includes('wrkrs-qa-engineer')) {
            appendFileSync(edited, '\nExternal edit made while wrkrs was running.\n')
            throw new Error('injected failure after external edit')
          }
          return next(...args)
        },
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    expect(result.retained.map((item) => item.path)).toContain(
      '.claude/agents/wrkrs-product-designer.md',
    )
    expect(result.retained.map((item) => item.path)).toContain('.claude/agents')
    expect(result.journalPath).toBe('.wrkrs/.journal.json')
    expect(readFileSync(edited, 'utf8')).toContain('External edit made while wrkrs was running.')
    expect(existsSync(path.join(root, '.claude', 'agents', 'wrkrs-product-manager.md'))).toBe(false)
    expect(existsSync(path.join(root, '.wrkrs', '.lock'))).toBe(false)
    const journal = JSON.parse(
      readFileSync(path.join(root, '.wrkrs', '.journal.json'), 'utf8'),
    ) as {
      status: string
      operations: { path: string; status: string }[]
    }
    expect(journal.status).toBe('rollback-incomplete')
    expect(
      journal.operations.find(
        (operation) => operation.path === '.claude/agents/wrkrs-product-designer.md',
      )?.status,
    ).toBe('retained')

    const deps = createTestDependencies()
    const check = await runCheck(
      {
        cwd: root,
        wrkrsVersion: deps.wrkrsVersion,
        adapters: deps.adapters,
        providers: deps.providers,
      },
      ports,
    )
    expect(check.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'TRANSACTION_INTERRUPTED',
    )

    const replan = await prepareInit(root, deps, ports)
    expect(replan.ok && replan.value.plan.blockers.map((blocker) => blocker.code)).toContain(
      'OWNERSHIP_TRANSACTION_INTERRUPTED',
    )
  })
})
