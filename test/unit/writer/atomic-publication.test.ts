import { existsSync, readFileSync, statSync, writeFileSync, promises as fsp } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createStyler, renderApplyResult } from '../../../src/cli/output/human-reporter.js'
import { applyResultToJson } from '../../../src/cli/output/json-reporter.js'
import { AtomicPublicationUnsupportedError } from '../../../src/core/ports.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import { createNodeFileSystem } from '../../../src/platform/filesystem.js'
import { createTestDependencies, createTestPorts } from '../../helpers/ports.js'
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
  vi.restoreAllMocks()
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

async function prepare(root: string, ports: InitPorts) {
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return prepared.value
}

function linkFailure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected link failure`), { code })
}

describe('atomic no-replace publication', () => {
  it('fails closed when the filesystem cannot create hard links: no copy, no target', async () => {
    const directory = makeTempDir()
    cleanup.push(directory)
    const copyFile = vi.spyOn(fsp, 'copyFile')
    const link = vi.spyOn(fsp, 'link').mockRejectedValueOnce(linkFailure('EPERM'))
    const fs = createNodeFileSystem()
    await fs.withinDirectory(directory, '', async (bound) => {
      await bound.writeFileExclusive('.stage.tmp', new TextEncoder().encode('content\n'), 0o644)
      await expect(bound.linkExclusive('.stage.tmp', 'target.md')).rejects.toBeInstanceOf(
        AtomicPublicationUnsupportedError,
      )
    })
    expect(link).toHaveBeenCalledTimes(1)
    expect(copyFile).not.toHaveBeenCalled()
    expect(existsSync(path.join(directory, 'target.md'))).toBe(false)
    expect(existsSync(path.join(directory, '.stage.tmp'))).toBe(true)
  })

  it('reports a controlled environment conflict, restores the tree, and never leaks the raw filesystem message', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const before = hashTree(root)
    const copyFile = vi.spyOn(fsp, 'copyFile')
    const realLink = fsp.link
    let injected = 0
    vi.spyOn(fsp, 'link').mockImplementation(async (from, to) => {
      if (String(to) === 'wrkrs-qa-engineer.md') {
        injected += 1
        throw linkFailure('EXDEV')
      }
      return realLink(from, to)
    })
    const ports = createTestPorts()
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(injected).toBe(1)
    expect(copyFile).not.toHaveBeenCalled()
    expect(result.status).toBe('rolled-back')
    if (result.status !== 'rolled-back') return
    expect(result.conflict?.code).toBe('ENVIRONMENT_ATOMIC_PUBLICATION_UNSUPPORTED')
    expect(result.conflict?.path).toBe('.claude/agents/wrkrs-qa-engineer.md')
    const human = renderApplyResult(result, createStyler(false))
    const json = JSON.stringify(applyResultToJson(result))
    for (const output of [human, json]) {
      expect(output).toContain('ENVIRONMENT_ATOMIC_PUBLICATION_UNSUPPORTED')
      expect(output).toContain('hard links')
      expect(output).not.toContain('injected link failure')
      expect(output).not.toContain('EXDEV')
    }
    expect(hashTree(root)).toBe(before)
    expect(existsSync(path.join(root, '.claude'))).toBe(false)
    expect(existsSync(path.join(root, '.wrkrs'))).toBe(false)
  })

  it('never replaces an existing target even when the link primitive is exercised for real', async () => {
    const directory = makeTempDir()
    cleanup.push(directory)
    writeFileSync(path.join(directory, 'target.md'), 'external\n', { mode: 0o600 })
    const fs = createNodeFileSystem()
    await fs.withinDirectory(directory, '', async (bound) => {
      await bound.writeFileExclusive('.stage.tmp', new TextEncoder().encode('ours\n'), 0o644)
      await expect(bound.linkExclusive('.stage.tmp', 'target.md')).rejects.toMatchObject({
        code: 'EEXIST',
      })
    })
    expect(readFileSync(path.join(directory, 'target.md'), 'utf8')).toBe('external\n')
    expect(fileMode(path.join(directory, 'target.md'))).toBe(0o600)
  })

  it('publishes atomically on the normal hard-link path: the target is the staged inode', async () => {
    const directory = makeTempDir()
    cleanup.push(directory)
    const fs = createNodeFileSystem()
    await fs.withinDirectory(directory, '', async (bound) => {
      await bound.writeFileExclusive('.stage.tmp', new TextEncoder().encode('atomic\n'), 0o644)
      await bound.linkExclusive('.stage.tmp', 'target.md')
    })
    const target = statSync(path.join(directory, 'target.md'))
    const staging = statSync(path.join(directory, '.stage.tmp'))
    expect(target.ino).toBe(staging.ino)
    expect(target.nlink).toBe(2)
    expect(readFileSync(path.join(directory, 'target.md'), 'utf8')).toBe('atomic\n')
    expect(
      readTree(directory)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(['.stage.tmp', 'target.md'])
  })
})
