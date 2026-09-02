import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runCheck } from '../../../src/check/check.js'
import {
  createStyler,
  renderApplyResult,
  renderCheck,
  renderPlan,
} from '../../../src/cli/output/human-reporter.js'
import {
  applyResultToJson,
  checkToJson,
  planToJson,
} from '../../../src/cli/output/json-reporter.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import {
  createTestDependencies,
  createTestPorts,
  interceptFileSystem,
  recordReads,
  type FileSystemInterceptors,
} from '../../helpers/ports.js'
import {
  createFixtureRepository,
  hashTree,
  makeTempDir,
  readTree,
  removeDir,
  type FixtureName,
} from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const SENTINEL = 'RACE_S3NT1N3L_4b8c'
const AGENTS = '.claude/agents'
const style = createStyler(false)

function outsideTree(): string {
  const outside = makeTempDir('wrkrs-outside-')
  cleanup.push(outside)
  for (const name of [
    'custom-reviewer.md',
    'wrkrs-product-manager.md',
    'wrkrs-product-designer.md',
    'wrkrs-qa-engineer.md',
  ]) {
    writeFileSync(path.join(outside, name), `---\nname: ${SENTINEL}\n---\n${SENTINEL}\n`, {
      mode: 0o600,
    })
  }
  return outside
}

/** Replaces an existing real directory with a symlink to the outside tree; the real directory is kept aside. */
function swapToOutside(root: string, relative: string, outside: string): string {
  const real = path.join(root, ...relative.split('/'))
  const aside = `${real}-real`
  renameSync(real, aside)
  symlinkSync(outside, real)
  return aside
}

async function prepare(root: string, ports: InitPorts) {
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return prepared.value
}

function expectRedacted(text: string): void {
  expect(text).not.toContain(SENTINEL)
  expect(text).not.toContain(SENTINEL.slice(0, 8))
}

describe('containment is bound to each operation', () => {
  it('refuses a second scanner read after an ancestor that was real on the first access becomes an outside symlink', async () => {
    const root = createFixtureRepository('existing-claude-repository', { commit: true })
    cleanup.push(root)
    const outside = outsideTree()
    const outsideBefore = readTree(outside)
    let accesses = 0
    let swapped = false
    const recorder = recordReads(createTestPorts().fs)
    const fs = interceptFileSystem(recorder.fs, {
      withinDirectory: async (context, next) => {
        if (context.relativeDirectory === AGENTS) {
          accesses += 1
          if (accesses === 2 && !swapped) {
            // The first access (the directory listing) succeeded against the real directory;
            // replace it before the second access (reading a component inside it).
            swapToOutside(root, AGENTS, outside)
            swapped = true
          }
        }
        return next()
      },
    })
    const ports = createTestPorts({ fs })
    const prepared = await prepare(root, ports)
    expect(swapped).toBe(true)
    const plan = prepared.plan
    expect(plan.findings.map((finding) => finding.code)).toContain('SCAN_PATH_UNSAFE')
    expect(plan.blockers.map((blocker) => blocker.code)).toContain('PATH_ANCESTOR_SYMLINK')
    expectRedacted(renderPlan(plan, style, { dryRun: true }))
    expectRedacted(JSON.stringify(planToJson(plan)))
    expect(
      recorder.reads.filter((read) => read.startsWith(`${AGENTS}/`) && read !== `${AGENTS}/`),
    ).toEqual([])
    expect(readTree(outside)).toEqual(outsideBefore)

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
    expectRedacted(renderCheck(report, style, deps.wrkrsVersion))
    expectRedacted(JSON.stringify(checkToJson(report, deps.wrkrsVersion)))
    expect(readTree(outside)).toEqual(outsideBefore)
  })

  it('creates nothing outside when an ancestor is swapped after preconditions but before staging', async () => {
    const root = createFixtureRepository('existing-claude-repository', { commit: true })
    cleanup.push(root)
    const outside = outsideTree()
    const outsideBefore = readTree(outside)
    const before = hashTree(root)
    let swapped = false
    const interceptors: FileSystemInterceptors = {
      bound: {
        // The 'applying' journal write is the last step before the first staging write.
        rename: async (args, next) => {
          const result = await next(...args)
          if (args[1] === '.journal.json' && !swapped) {
            const journal = JSON.parse(readFileSync('.journal.json', 'utf8')) as { status: string }
            if (journal.status === 'applying') {
              swapToOutside(root, AGENTS, outside)
              swapped = true
            }
          }
          return result
        },
      },
    }
    const ports = createTestPorts({ fs: interceptFileSystem(createTestPorts().fs, interceptors) })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(swapped).toBe(true)
    expect(result.status).toBe('rolled-back')
    if (result.status === 'rolled-back') {
      expect(result.conflict?.code).toBe('PATH_ANCESTOR_CHANGED')
      expectRedacted(renderApplyResult(result, style))
      expectRedacted(JSON.stringify(applyResultToJson(result)))
    }
    expect(readTree(outside)).toEqual(outsideBefore)
    expect(readTree(path.join(root, '.claude', 'agents-real')).map((entry) => entry.path)).toEqual([
      'custom-reviewer.md',
    ])
    // Restore the real directory and prove nothing else changed.
    renameSync(path.join(root, '.claude', 'agents'), path.join(root, '.claude', 'agents-link'))
    renameSync(path.join(root, '.claude', 'agents-real'), path.join(root, '.claude', 'agents'))
    expect(readTree(root).filter((entry) => entry.path !== '.claude/agents-link')).toEqual(
      readTree(createFixtureRepository('existing-claude-repository', { commit: true })).filter(
        () => true,
      ),
    )
    expect(hashTree(root)).not.toBe(before) // the symlink we left behind is the only difference
  })

  it('creates no target outside when an ancestor is swapped between staging and publication', async () => {
    const root = createFixtureRepository('existing-claude-repository', { commit: true })
    cleanup.push(root)
    const outside = outsideTree()
    const outsideBefore = readTree(outside)
    let swapped = false
    const interceptors: FileSystemInterceptors = {
      bound: {
        writeFileExclusive: async (args, next, directory) => {
          await next(...args)
          if (directory.relativePath === AGENTS && !swapped) {
            swapToOutside(root, AGENTS, outside)
            swapped = true
          }
        },
      },
    }
    const ports = createTestPorts({ fs: interceptFileSystem(createTestPorts().fs, interceptors) })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(swapped).toBe(true)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status === 'rollback-incomplete') {
      expect(result.conflict?.code).toBe('PATH_ANCESTOR_CHANGED')
      expect(
        result.retained
          .map((item) => item.path)
          .some((item) => item.startsWith(`${AGENTS}/.wrkrs-`)),
      ).toBe(true)
      expectRedacted(renderApplyResult(result, style))
      expectRedacted(JSON.stringify(applyResultToJson(result)))
    }
    expect(readTree(outside)).toEqual(outsideBefore)
    const realEntries = readTree(path.join(root, '.claude', 'agents-real')).map(
      (entry) => entry.path,
    )
    expect(realEntries.filter((entry) => !entry.startsWith('.'))).toEqual(['custom-reviewer.md'])
  })

  it('does not delete an outside file when an ancestor changes before rollback', async () => {
    const root = createFixtureRepository('existing-claude-repository', { commit: true })
    cleanup.push(root)
    const outside = outsideTree()
    const outsideBefore = readTree(outside)
    let swapped = false
    const interceptors: FileSystemInterceptors = {
      bound: {
        writeFileExclusive: async (args, next) => {
          if (args[0].includes('wrkrs-qa-engineer') && !swapped) {
            // Two agents are already published in the real directory; swap it away
            // so rollback must reach them through the (now symlinked) ancestor.
            swapToOutside(root, AGENTS, outside)
            swapped = true
            throw new Error('injected write failure after swap')
          }
          return next(...args)
        },
      },
    }
    const ports = createTestPorts({ fs: interceptFileSystem(createTestPorts().fs, interceptors) })
    const prepared = await prepare(root, ports)
    const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
    expect(swapped).toBe(true)
    expect(result.status).toBe('rollback-incomplete')
    if (result.status === 'rollback-incomplete') {
      const retained = result.retained.map((item) => item.path)
      expect(retained).toContain(`${AGENTS}/wrkrs-product-designer.md`)
      expect(retained).toContain(`${AGENTS}/wrkrs-product-manager.md`)
      expectRedacted(renderApplyResult(result, style))
      expectRedacted(JSON.stringify(applyResultToJson(result)))
    }
    // The outside files that share the retained names are untouched, byte for byte and mode for mode.
    expect(readTree(outside)).toEqual(outsideBefore)
    for (const name of ['wrkrs-product-manager.md', 'wrkrs-product-designer.md']) {
      expect(existsSync(path.join(outside, name))).toBe(true)
      expect(readFileSync(path.join(outside, name), 'utf8')).toContain(SENTINEL)
    }
    const real = readTree(path.join(root, '.claude', 'agents-real')).map((entry) => entry.path)
    expect(real).toContain('wrkrs-product-designer.md')
    expect(real).toContain('wrkrs-product-manager.md')
  })

  it.each(['clean-repository', 'existing-claude-repository'] as FixtureName[])(
    'still installs %s normally through the bound-directory port',
    async (fixture) => {
      const root = createFixtureRepository(fixture, { commit: true })
      cleanup.push(root)
      const ports = createTestPorts()
      const prepared = await prepare(root, ports)
      const result = await applyPreparedInit(prepared, createTestDependencies(), ports)
      expect(result.status).toBe('applied')
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
      expect(report.ok).toBe(true)
      expect(existsSync(path.join(root, '.wrkrs', '.journal.json'))).toBe(false)
      mkdirSync(path.join(root, 'untouched'))
    },
  )
})
