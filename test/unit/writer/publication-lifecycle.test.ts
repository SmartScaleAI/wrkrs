import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileSystemError } from '../../../src/core/ports.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import {
  createTestDependencies,
  createTestPorts,
  interceptFileSystem,
  type FileSystemInterceptors,
} from '../../helpers/ports.js'
import { createFixtureRepository, hashTree, readTree, removeDir } from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const AGENT_DIRECTORY = '.claude/agents'
const AGENT_NAME = 'wrkrs-qa-engineer.md'
const AGENT = `${AGENT_DIRECTORY}/${AGENT_NAME}`
const STAGING_NAME = /^\.wrkrs-qa-engineer\.md\.wrkrs-[0-9a-f]{8}\.tmp$/

async function prepare(root: string, ports: InitPorts) {
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return prepared.value
}

function repo() {
  const root = createFixtureRepository('existing-claude-repository', { commit: true })
  cleanup.push(root)
  return root
}

function agentEntries(root: string) {
  return readTree(root)
    .filter(
      (entry) => entry.path.startsWith(`${AGENT_DIRECTORY}/`) && entry.path.includes('qa-engineer'),
    )
    .map((entry) => entry.path)
}

function unlinkFailure(
  predicate: (name: string, directory: string) => boolean,
  options: { times?: number } = {},
): { interceptors: FileSystemInterceptors; failures: () => number } {
  let failures = 0
  return {
    failures: () => failures,
    interceptors: {
      bound: {
        unlink: async (args, next, directory) => {
          if (
            predicate(args[0], directory.relativePath) &&
            (options.times === undefined || failures < options.times)
          ) {
            failures += 1
            throw new FileSystemError('EIO', args[0], 'injected: staging name could not be removed')
          }
          return next(...args)
        },
      },
    },
  }
}

describe('publication lifecycle: target creation and staging cleanup are separate steps', () => {
  it('rolls back both names when the target link succeeds but the staging unlink fails once', async () => {
    const root = repo()
    const before = hashTree(root)
    const injected = unlinkFailure(
      (name, directory) => directory === AGENT_DIRECTORY && STAGING_NAME.test(name),
      { times: 1 },
    )
    const ports = createTestPorts({
      fs: interceptFileSystem(createTestPorts().fs, injected.interceptors),
    })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(injected.failures()).toBe(1)
    expect(result.status).toBe('rolled-back')
    if (result.status === 'rolled-back') expect(result.failure).toContain('EIO')
    expect(agentEntries(root)).toEqual([])
    expect(hashTree(root)).toBe(before)
  })

  it('reports the exact retained staging path when the staging name can never be removed', async () => {
    const root = repo()
    const injected = unlinkFailure(
      (name, directory) => directory === AGENT_DIRECTORY && STAGING_NAME.test(name),
    )
    const ports = createTestPorts({
      fs: interceptFileSystem(createTestPorts().fs, injected.interceptors),
    })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    const retained = result.retained.map((item) => item.path)
    const stagingPath = retained.find((item) => STAGING_NAME.test(path.posix.basename(item)))
    expect(stagingPath).toBeDefined()
    expect(stagingPath!.startsWith(`${AGENT_DIRECTORY}/`)).toBe(true)
    expect(retained).not.toContain(AGENT)
    expect(existsSync(path.join(root, ...AGENT.split('/')))).toBe(false)
    expect(existsSync(path.join(root, ...stagingPath!.split('/')))).toBe(true)
    const journal = JSON.parse(
      readFileSync(path.join(root, '.wrkrs', '.journal.json'), 'utf8'),
    ) as {
      status: string
      operations: { path: string; status: string; stagingPath: string | null }[]
    }
    expect(journal.status).toBe('rollback-incomplete')
    const op = journal.operations.find((operation) => operation.path === AGENT)
    expect(op?.status).toBe('retained')
    expect(op?.stagingPath).toBe(stagingPath)
  })

  it('records publication in memory before persisting, so a journal failure with staging present still removes both names', async () => {
    const root = repo()
    const before = hashTree(root)
    let failed = 0
    const fs = interceptFileSystem(createTestPorts().fs, {
      bound: {
        rename: async (args, next) => {
          if (args[1] === '.journal.json' && failed === 0) {
            const pending = JSON.parse(readFileSync(args[0], 'utf8')) as {
              operations: { path: string; status: string; stagingPath: string | null }[]
            }
            const op = pending.operations.find((operation) => operation.path === AGENT)
            if (op?.status === 'published' && op.stagingPath !== null) {
              failed += 1
              throw new FileSystemError(
                'EIO',
                args[1],
                'injected journal failure after publication',
              )
            }
          }
          return next(...args)
        },
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(failed).toBe(1)
    expect(result.status).toBe('rolled-back')
    expect(agentEntries(root)).toEqual([])
    expect(hashTree(root)).toBe(before)
  })

  it('cannot report rolled-back while either the target or the staging name still exists', async () => {
    const root = repo()
    const injected = unlinkFailure(
      (name, directory) =>
        directory === AGENT_DIRECTORY && (name === AGENT_NAME || STAGING_NAME.test(name)),
    )
    const ports = createTestPorts({
      fs: interceptFileSystem(createTestPorts().fs, injected.interceptors),
    })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    const retained = result.retained.map((item) => item.path)
    expect(retained).toContain(AGENT)
    expect(retained.some((item) => STAGING_NAME.test(path.posix.basename(item)))).toBe(true)
    expect(agentEntries(root).length).toBe(2)
    for (const entry of agentEntries(root)) expect(retained).toContain(entry)
  })

  it('leaves externally created targets byte- and mode-identical through publication failures', async () => {
    const root = repo()
    const externalPath = path.join(root, '.claude', 'agents', 'custom-reviewer.md')
    const externalBefore = readTree(root).find(
      (entry) => entry.path === '.claude/agents/custom-reviewer.md',
    )
    const injected = unlinkFailure(
      (name, directory) => directory === AGENT_DIRECTORY && STAGING_NAME.test(name),
    )
    const ports = createTestPorts({
      fs: interceptFileSystem(createTestPorts().fs, injected.interceptors),
    })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(result.status).toBe('rollback-incomplete')
    expect(
      readTree(root).find((entry) => entry.path === '.claude/agents/custom-reviewer.md'),
    ).toEqual(externalBefore)
    expect(existsSync(externalPath)).toBe(true)
  })
})
