import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runCheck } from '../../../src/check/check.js'
import { FileSystemError } from '../../../src/core/ports.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import { createNodeFileSystem } from '../../../src/platform/filesystem.js'
import {
  createTestDependencies,
  createTestPorts,
  interceptFileSystem,
} from '../../helpers/ports.js'
import {
  createFixtureRepository,
  fileMode,
  hashTree,
  makeTempDir,
  readTree,
  removeDir,
} from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const TARGET = '.claude/agents/wrkrs-qa-engineer.md'
const EXTERNAL_BYTES = 'created by another process at the last moment\n'

async function prepare(root: string, ports: InitPorts) {
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return prepared.value
}

/** Filesystem that creates an external target immediately before wrkrs publishes it. */
function raceAt(target: string) {
  const raced = { count: 0 }
  const fs = interceptFileSystem(createTestPorts().fs, {
    publishFileExclusive: async (args, next) => {
      if (args[1].endsWith(target.split('/').join(path.sep))) {
        raced.count += 1
        writeFileSync(args[1], EXTERNAL_BYTES, { mode: 0o600 })
      }
      return next(...args)
    },
  })
  return { fs, raced }
}

describe('publishFileExclusive (Node port)', () => {
  it('publishes staged content atomically and refuses to replace files, directories, or symlinks', async () => {
    const directory = makeTempDir()
    cleanup.push(directory)
    const fs = createNodeFileSystem()
    const staging = path.join(directory, '.target.tmp')
    const target = path.join(directory, 'target.md')
    await fs.writeFileExclusive(staging, new TextEncoder().encode('hello\n'), 0o644)
    await fs.publishFileExclusive(staging, target)
    expect(readFileSync(target, 'utf8')).toBe('hello\n')
    expect(existsSync(staging)).toBe(false)
    expect(fileMode(target)).toBe(0o644)

    for (const [name, create] of [
      ['file', () => writeFileSync(path.join(directory, 'file.md'), 'keep\n', { mode: 0o600 })],
      ['directory', () => mkdirSync(path.join(directory, 'directory.md'))],
      [
        'symlink',
        () => symlinkSync(path.join(directory, 'missing'), path.join(directory, 'symlink.md')),
      ],
    ] as const) {
      create()
      const existing = path.join(directory, `${name}.md`)
      const before = readTree(directory)
      const stage = path.join(directory, `.${name}.tmp`)
      await fs.writeFileExclusive(stage, new TextEncoder().encode('new\n'), 0o644)
      await expect(fs.publishFileExclusive(stage, existing)).rejects.toMatchObject({
        code: 'EEXIST',
      })
      expect(existsSync(stage)).toBe(true)
      await fs.unlink(stage)
      expect(readTree(directory)).toEqual(before.filter((entry) => !entry.path.endsWith('.tmp')))
    }
    expect(readFileSync(path.join(directory, 'file.md'), 'utf8')).toBe('keep\n')
    expect(fileMode(path.join(directory, 'file.md'))).toBe(0o600)
  })
})

describe('no-clobber publication during apply', () => {
  it('never overwrites a target that appears in a pre-existing .claude/agents and rolls everything else back', async () => {
    const root = createFixtureRepository('existing-claude-repository', { commit: true })
    cleanup.push(root)
    const { fs, raced } = raceAt(TARGET)
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const before = hashTree(root)

    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(raced.count).toBe(1)
    expect(result.status).toBe('rolled-back')
    if (result.status !== 'rolled-back') return
    expect(result.conflict?.code).toBe('PRECONDITION_TARGET_APPEARED')
    expect(result.conflict?.path).toBe(TARGET)
    expect(result.failure).toContain(TARGET)

    const external = path.join(root, ...TARGET.split('/'))
    expect(readFileSync(external, 'utf8')).toBe(EXTERNAL_BYTES)
    expect(fileMode(external)).toBe(0o600)
    // Everything wrkrs created is gone; the tree equals the pre-apply tree plus the external file.
    const after = readTree(root).filter((entry) => entry.path !== TARGET)
    expect(hashTree(root)).not.toBe(before)
    expect(JSON.stringify(after)).toBe(
      JSON.stringify(readTree(root).filter((entry) => entry.path !== TARGET)),
    )
    expect(readTree(root).filter((entry) => entry.path.startsWith('.wrkrs'))).toEqual([])
    expect(
      readTree(root).filter((entry) => entry.path.includes('wrkrs-') && entry.path !== TARGET),
    ).toEqual([])
    const fresh = createFixtureRepository('existing-claude-repository', { commit: true })
    cleanup.push(fresh)
    expect(hashTree(root)).not.toBe(hashTree(fresh))
    expect(readTree(root).map((entry) => entry.path)).toEqual(
      [...readTree(fresh).map((entry) => entry.path), TARGET].sort(),
    )
  })

  it('preserves the external target and reports our non-empty directories when the race happens in a clean repository', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const { fs, raced } = raceAt(TARGET)
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)

    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(raced.count).toBe(1)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status !== 'rollback-incomplete') return
    expect(result.conflict?.code).toBe('PRECONDITION_TARGET_APPEARED')
    expect(result.conflict?.path).toBe(TARGET)
    const external = path.join(root, ...TARGET.split('/'))
    expect(readFileSync(external, 'utf8')).toBe(EXTERNAL_BYTES)
    expect(fileMode(external)).toBe(0o600)
    const retainedPaths = result.retained.map((item) => item.path)
    expect(retainedPaths).not.toContain(TARGET)
    expect(retainedPaths).toContain('.claude/agents')
    expect(retainedPaths).toContain('.claude')
    expect(
      readTree(root).filter((entry) => entry.kind === 'file' && entry.path.startsWith('.claude/')),
    ).toEqual([expect.objectContaining({ path: TARGET, mode: 0o600 })])
    expect(existsSync(path.join(root, '.wrkrs', '.journal.json'))).toBe(true)
    const journal = JSON.parse(
      readFileSync(path.join(root, '.wrkrs', '.journal.json'), 'utf8'),
    ) as {
      status: string
      operations: { path: string; status: string; note: string | null }[]
    }
    expect(journal.status).toBe('rollback-incomplete')
    const op = journal.operations.find((operation) => operation.path === TARGET)
    expect(op?.status).not.toBe('published')
    expect(op?.note).toContain('left untouched')
    const deps = createTestDependencies()
    const report = await runCheck(
      {
        cwd: root,
        wrkrsVersion: deps.wrkrsVersion,
        adapters: deps.adapters,
        providers: deps.providers,
      },
      ports,
    )
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'TRANSACTION_INTERRUPTED',
    )
  })

  it('surfaces EEXIST from the port as the transactional conflict, never as an overwrite', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    let observed: string | null = null
    const fs = interceptFileSystem(createTestPorts().fs, {
      publishFileExclusive: async (args, next) => {
        if (args[1].endsWith('config.yaml')) {
          mkdirSync(args[1])
          try {
            await next(...args)
          } catch (error) {
            observed = error instanceof FileSystemError ? error.code : 'other'
            throw error
          }
        }
        return next(...args)
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(observed).toBe('EEXIST')
    expect(result.status).toBe('rollback-incomplete')
    if (result.status === 'rollback-incomplete') {
      expect(result.conflict?.path).toBe('.wrkrs/config.yaml')
      expect(result.retained.map((item) => item.path)).not.toContain('.wrkrs/config.yaml')
    }
    expect(existsSync(path.join(root, '.wrkrs', 'config.yaml'))).toBe(true)
  })
})
