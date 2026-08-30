import {
  mkdirSync,
  promises as fsp,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ContainmentError, type BoundDirectory } from '../../../src/core/ports.js'
import { applyPreparedInit, prepareInit } from '../../../src/init/init.js'
import { createNodeFileSystem } from '../../../src/platform/filesystem.js'
import { createTestDependencies, createTestPorts } from '../../helpers/ports.js'
import { createFixtureRepository, makeTempDir, readTree, removeDir } from '../../helpers/temp.js'

const cleanup: string[] = []
const originalCwd = process.cwd()
afterEach(() => {
  vi.restoreAllMocks()
  process.chdir(originalCwd)
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

function tree(): string {
  const root = makeTempDir()
  cleanup.push(root)
  mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
  writeFileSync(path.join(root, '.claude', 'agents', 'a.md'), 'a\n')
  return root
}

describe('process-wide directory binding', () => {
  it('rejects a nested withinDirectory call promptly instead of deadlocking', async () => {
    const root = tree()
    const fs = createNodeFileSystem()
    let nested: unknown = null
    await fs.withinDirectory(root, '.claude', async (bound) => {
      await bound.lstat('agents')
      nested = await fs
        .withinDirectory(root, '.claude/agents', async () => 'reached')
        .catch((error: unknown) => error)
      return 'outer done'
    })
    expect(nested).toBeInstanceOf(ContainmentError)
    expect((nested as ContainmentError).code).toBe('CONTAINMENT_REENTRANT')
    expect(process.cwd()).toBe(originalCwd)
  }, 5_000)

  it('serializes concurrent calls from different filesystem instances', async () => {
    const root = tree()
    const a = createNodeFileSystem()
    const b = createNodeFileSystem()
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = a.withinDirectory(root, '.claude', async () => {
      log.push('a:start')
      expect(path.basename(process.cwd())).toBe('.claude')
      await gate
      expect(path.basename(process.cwd())).toBe('.claude')
      log.push('a:end')
    })
    const second = b.withinDirectory(root, '.claude/agents', async () => {
      log.push('b:start')
      expect(path.basename(process.cwd())).toBe('agents')
      log.push('b:end')
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(log).toEqual(['a:start'])
    release()
    await Promise.all([first, second])
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
    expect(process.cwd()).toBe(originalCwd)
  })

  it('cannot cross-read or cross-write between two repositories installed concurrently', async () => {
    const left = createFixtureRepository('clean-repository', { commit: true })
    const right = createFixtureRepository('existing-claude-repository', { commit: true })
    cleanup.push(left, right)
    const leftPorts = createTestPorts({ fs: createNodeFileSystem() })
    const rightPorts = createTestPorts({ fs: createNodeFileSystem() })
    const [leftPrepared, rightPrepared] = await Promise.all([
      prepareInit(left, createTestDependencies(), leftPorts),
      prepareInit(right, createTestDependencies(), rightPorts),
    ])
    if (!leftPrepared.ok || !rightPrepared.ok) throw new Error('prepare failed')
    const [leftResult, rightResult] = await Promise.all([
      applyPreparedInit(leftPrepared.value, createTestDependencies(), leftPorts),
      applyPreparedInit(rightPrepared.value, createTestDependencies(), rightPorts),
    ])
    expect(leftResult.status).toBe('applied')
    expect(rightResult.status).toBe('applied')
    const leftManifest = JSON.parse(
      await fsp.readFile(path.join(left, '.wrkrs', 'manifest.json'), 'utf8'),
    ) as { installationId: string }
    const rightManifest = JSON.parse(
      await fsp.readFile(path.join(right, '.wrkrs', 'manifest.json'), 'utf8'),
    ) as { installationId: string }
    expect(leftManifest.installationId).toBe(leftPrepared.value.plan.installationId)
    expect(rightManifest.installationId).toBe(rightPrepared.value.plan.installationId)
    expect(readTree(left).some((entry) => entry.path === '.claude/agents/custom-reviewer.md')).toBe(
      false,
    )
    expect(
      readTree(right).some((entry) => entry.path === '.claude/agents/custom-reviewer.md'),
    ).toBe(true)
    expect(
      readdirSync(path.join(left, '.claude', 'agents')).filter((name) => name.startsWith('.')),
    ).toEqual([])
    expect(
      readdirSync(path.join(right, '.claude', 'agents')).filter((name) => name.startsWith('.')),
    ).toEqual([])
    expect(process.cwd()).toBe(originalCwd)
  })

  it('refuses to use a BoundDirectory after its callback completed', async () => {
    const root = tree()
    const fs = createNodeFileSystem()
    let captured: BoundDirectory | null = null
    await fs.withinDirectory(root, '.claude/agents', async (bound) => {
      captured = bound
      expect(await bound.lstat('a.md')).not.toBeNull()
    })
    expect(process.cwd()).toBe(originalCwd)
    await expect(captured!.lstat('a.md')).rejects.toMatchObject({ code: 'BOUND_DIRECTORY_CLOSED' })
    await expect(
      captured!.writeFileExclusive('late.md', new Uint8Array(), 0o644),
    ).rejects.toMatchObject({ code: 'BOUND_DIRECTORY_CLOSED' })
    expect(readdirSync(path.join(root, '.claude', 'agents'))).toEqual(['a.md'])
  })

  it('restores the working directory after success and after a failing callback', async () => {
    const root = tree()
    const fs = createNodeFileSystem()
    await fs.withinDirectory(root, '.claude', async () => {
      expect(path.basename(process.cwd())).toBe('.claude')
    })
    expect(process.cwd()).toBe(originalCwd)
    await expect(
      fs.withinDirectory(root, '.claude/agents', async () => {
        throw new Error('callback failure')
      }),
    ).rejects.toThrow('callback failure')
    expect(process.cwd()).toBe(originalCwd)
    await expect(fs.withinDirectory(root, '.claude/missing', async () => 1)).rejects.toMatchObject({
      code: 'PATH_ANCESTOR_MISSING',
    })
    expect(process.cwd()).toBe(originalCwd)
  })

  it('fails closed when a segment disappears between inspection and entry', async () => {
    const root = tree()
    const fs = createNodeFileSystem()
    const realLstat = fsp.lstat
    let removed = false
    vi.spyOn(fsp, 'lstat').mockImplementation(async (target, ...rest) => {
      const stats = await (realLstat as (...args: unknown[]) => Promise<unknown>)(target, ...rest)
      if (String(target) === 'agents' && !removed) {
        removed = true
        rmSync(path.join(root, '.claude', 'agents'), { recursive: true })
      }
      return stats as never
    })
    const failure = await fs
      .withinDirectory(root, '.claude/agents', async () => 'reached')
      .catch((error: unknown) => error)
    expect(removed).toBe(true)
    expect(failure).toBeInstanceOf(ContainmentError)
    expect((failure as ContainmentError).code).toBe('PATH_ANCESTOR_CHANGED')
    expect((failure as ContainmentError).message).not.toMatch(/ENOENT|chdir/)
    expect(process.cwd()).toBe(originalCwd)
  })

  it('fails closed when a segment becomes a symlink or a file during binding', async () => {
    const outside = makeTempDir('wrkrs-outside-')
    cleanup.push(outside)
    writeFileSync(path.join(outside, 'secret.md'), 'OUTSIDE\n')
    for (const replacement of ['symlink', 'file'] as const) {
      const root = tree()
      const fs = createNodeFileSystem()
      const realLstat = fsp.lstat
      let swapped = false
      vi.spyOn(fsp, 'lstat').mockImplementation(async (target, ...rest) => {
        const stats = await (realLstat as (...args: unknown[]) => Promise<unknown>)(target, ...rest)
        if (String(target) === 'agents' && !swapped) {
          swapped = true
          const agents = path.join(root, '.claude', 'agents')
          rmSync(agents, { recursive: true })
          if (replacement === 'symlink') symlinkSync(outside, agents)
          else writeFileSync(agents, 'not a directory\n')
        }
        return stats as never
      })
      const failure = await fs
        .withinDirectory(root, '.claude/agents', async (bound) => bound.readDirectory())
        .catch((error: unknown) => error)
      vi.restoreAllMocks()
      expect(swapped).toBe(true)
      expect(failure).toBeInstanceOf(ContainmentError)
      expect((failure as ContainmentError).code).toBe('PATH_ANCESTOR_CHANGED')
      expect(readdirSync(outside)).toEqual(['secret.md'])
      expect(process.cwd()).toBe(originalCwd)
    }
  })
})
