import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

/**
 * Filesystem that creates an external target immediately before wrkrs links
 * it. The write happens inside the bound directory (the process working
 * directory at that moment), exactly where the link is about to be created.
 */
function raceAt(targetName: string) {
  const raced = { count: 0 }
  const fs = interceptFileSystem(createTestPorts().fs, {
    bound: {
      linkExclusive: async (args, next) => {
        if (args[1] === targetName) {
          raced.count += 1
          writeFileSync(args[1], EXTERNAL_BYTES, { mode: 0o600 })
        }
        return next(...args)
      },
    },
  })
  return { fs, raced }
}

describe('linkExclusive (Node port, bound directory)', () => {
  it('creates the target name atomically as a hard link and refuses to replace files, directories, or symlinks', async () => {
    const directory = makeTempDir()
    cleanup.push(directory)
    const fs = createNodeFileSystem()
    await fs.withinDirectory(directory, '', async (bound) => {
      await bound.writeFileExclusive('.target.tmp', new TextEncoder().encode('hello\n'), 0o644)
      await bound.linkExclusive('.target.tmp', 'target.md')
    })
    // Publication creates only the target name; staging cleanup is a separate step.
    expect(readFileSync(path.join(directory, 'target.md'), 'utf8')).toBe('hello\n')
    expect(existsSync(path.join(directory, '.target.tmp'))).toBe(true)
    expect(statSync(path.join(directory, 'target.md')).ino).toBe(
      statSync(path.join(directory, '.target.tmp')).ino,
    )
    expect(fileMode(path.join(directory, 'target.md'))).toBe(0o644)
    await fs.withinDirectory(directory, '', (bound) => bound.unlink('.target.tmp'))
    expect(existsSync(path.join(directory, '.target.tmp'))).toBe(false)

    for (const [name, create] of [
      ['file', () => writeFileSync(path.join(directory, 'file.md'), 'keep\n', { mode: 0o600 })],
      ['directory', () => mkdirSync(path.join(directory, 'directory.md'))],
      [
        'symlink',
        () => symlinkSync(path.join(directory, 'missing'), path.join(directory, 'symlink.md')),
      ],
    ] as const) {
      create()
      const before = readTree(directory)
      await fs.withinDirectory(directory, '', async (bound) => {
        await bound.writeFileExclusive(`.${name}.tmp`, new TextEncoder().encode('new\n'), 0o644)
        await expect(bound.linkExclusive(`.${name}.tmp`, `${name}.md`)).rejects.toMatchObject({
          code: 'EEXIST',
        })
        expect(await bound.lstat(`.${name}.tmp`)).not.toBeNull()
        await bound.unlink(`.${name}.tmp`)
      })
      expect(readTree(directory)).toEqual(before)
    }
    expect(readFileSync(path.join(directory, 'file.md'), 'utf8')).toBe('keep\n')
    expect(fileMode(path.join(directory, 'file.md'))).toBe(0o600)
  })
})

describe('no-clobber publication during apply', () => {
  it('never overwrites a target that appears in a pre-existing .claude/agents and rolls everything else back', async () => {
    const root = createFixtureRepository('existing-claude-repository', { commit: true })
    cleanup.push(root)
    const { fs, raced } = raceAt('wrkrs-qa-engineer.md')
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
    expect(hashTree(root)).not.toBe(before)
    expect(readTree(root).filter((entry) => entry.path.startsWith('.wrkrs'))).toEqual([])
    expect(
      readTree(root).filter((entry) => entry.path.includes('wrkrs-') && entry.path !== TARGET),
    ).toEqual([])
    const fresh = createFixtureRepository('existing-claude-repository', { commit: true })
    cleanup.push(fresh)
    // Every pre-existing entry is byte- and mode-identical; the only difference is the external file.
    const freshEntries = readTree(fresh)
    const afterEntries = readTree(root).filter((entry) => entry.path !== TARGET)
    expect(afterEntries).toEqual(freshEntries)
  })

  it('preserves the external target and reports our non-empty directories when the race happens in a clean repository', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const { fs, raced } = raceAt('wrkrs-qa-engineer.md')
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
      bound: {
        linkExclusive: async (args, next) => {
          if (args[1] === 'config.yaml') {
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
