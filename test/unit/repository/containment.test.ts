import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runCheck } from '../../../src/check/check.js'
import { createStyler, renderCheck, renderPlan } from '../../../src/cli/output/human-reporter.js'
import { checkToJson, planToJson } from '../../../src/cli/output/json-reporter.js'
import { applyPreparedInit, prepareInit } from '../../../src/init/init.js'
import { createRepositoryReader } from '../../../src/platform/contained-path.js'
import { createTestDependencies, createTestPorts, recordReads } from '../../helpers/ports.js'
import { createFixtureRepository, hashTree, makeTempDir, removeDir } from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const OUTSIDE_SENTINEL = 'OUTSIDE_S3NT1N3L_7d2f'
const style = createStyler(false)

/** Creates a directory outside the repository holding secret-bearing files. */
function outsideTree(): string {
  const outside = makeTempDir('wrkrs-outside-')
  cleanup.push(outside)
  mkdirSync(path.join(outside, 'agents'), { recursive: true })
  mkdirSync(path.join(outside, 'skills', 'wrkrs'), { recursive: true })
  mkdirSync(path.join(outside, 'roles'), { recursive: true })
  writeFileSync(
    path.join(outside, 'config.yaml'),
    `schemaVersion: 1\nsecret: ${OUTSIDE_SENTINEL}\n`,
  )
  writeFileSync(
    path.join(outside, 'manifest.json'),
    `{"schemaVersion": 1, "secret": "${OUTSIDE_SENTINEL}"}\n`,
  )
  writeFileSync(path.join(outside, '.journal.json'), `{"secret": "${OUTSIDE_SENTINEL}"}\n`)
  writeFileSync(
    path.join(outside, 'settings.json'),
    `{"permissions": {"allow": ["${OUTSIDE_SENTINEL}"]}}\n`,
  )
  writeFileSync(
    path.join(outside, 'agents', 'wrkrs-product-manager.md'),
    `---\nname: ${OUTSIDE_SENTINEL}\n---\n${OUTSIDE_SENTINEL}\n`,
  )
  writeFileSync(path.join(outside, 'agents', 'custom.md'), `---\nname: ${OUTSIDE_SENTINEL}\n---\n`)
  writeFileSync(
    path.join(outside, 'skills', 'wrkrs', 'SKILL.md'),
    `---\nname: ${OUTSIDE_SENTINEL}\n---\n`,
  )
  for (const role of ['product-manager', 'product-designer', 'software-engineer', 'qa-engineer']) {
    writeFileSync(
      path.join(outside, 'roles', `${role}.md`),
      `---\nid: ${role}\n---\n${OUTSIDE_SENTINEL}\n`,
    )
  }
  return outside
}

function expectNoLeak(text: string): void {
  expect(text).not.toContain(OUTSIDE_SENTINEL)
  expect(text).not.toContain(OUTSIDE_SENTINEL.slice(0, 10))
}

function expectNoReadsThrough(reads: string[], prefixes: string[]): void {
  for (const read of reads) {
    // Bound reads are recorded as "<directory>/<name>"; anything absolute or
    // traversing would mean a read escaped the bound directory model.
    expect(read.startsWith('/')).toBe(false)
    expect(read.includes('..')).toBe(false)
    for (const prefix of prefixes) {
      expect(read === `${prefix}/` || read.startsWith(`${prefix}/`)).toBe(false)
    }
  }
}

async function dryRunOutputs(root: string, fs: ReturnType<typeof recordReads>['fs']) {
  const ports = createTestPorts({ fs })
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  const plan = prepared.value.plan
  return {
    plan,
    human: renderPlan(plan, style, { dryRun: true }),
    json: JSON.stringify(planToJson(plan)),
  }
}

async function checkOutputs(root: string, fs: ReturnType<typeof recordReads>['fs']) {
  const deps = createTestDependencies()
  const report = await runCheck(
    {
      cwd: root,
      wrkrsVersion: deps.wrkrsVersion,
      adapters: deps.adapters,
      providers: deps.providers,
    },
    createTestPorts({ fs }),
  )
  return {
    report,
    human: renderCheck(report, style, deps.wrkrsVersion),
    json: JSON.stringify(checkToJson(report, deps.wrkrsVersion)),
  }
}

describe('read containment', () => {
  it('never follows a .wrkrs symlink that points outside the repository', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const outside = outsideTree()
    symlinkSync(outside, path.join(root, '.wrkrs'))
    const before = hashTree(root)
    const { fs, reads } = recordReads(createTestPorts().fs)

    const dry = await dryRunOutputs(root, fs)
    expect(dry.plan.blockers.map((blocker) => blocker.code)).toContain('PATH_WRKRS_NOT_A_DIRECTORY')
    const wrkrsOperations = dry.plan.operations.filter((operation) =>
      operation.path.startsWith('.wrkrs/'),
    )
    expect(wrkrsOperations.length).toBeGreaterThan(0)
    for (const operation of wrkrsOperations) {
      expect(operation.outcome).toBe('block')
      expect(operation.blocker?.code).toBe('PATH_ANCESTOR_SYMLINK')
    }
    expectNoLeak(dry.human)
    expectNoLeak(dry.json)

    const check = await checkOutputs(root, fs)
    expect(check.report.ok).toBe(false)
    expect(check.report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        'CONFIG_PATH_UNSAFE',
        'MANIFEST_PATH_UNSAFE',
        'TRANSACTION_PATH_UNSAFE',
      ]),
    )
    expectNoLeak(check.human)
    expectNoLeak(check.json)
    expectNoReadsThrough(reads, ['.wrkrs'])
    expect(hashTree(root)).toBe(before)
  })

  it('never follows a .claude symlink that points outside the repository', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const outside = outsideTree()
    symlinkSync(outside, path.join(root, '.claude'))
    const { fs, reads } = recordReads(createTestPorts().fs)

    const dry = await dryRunOutputs(root, fs)
    expect(dry.plan.blockers.map((blocker) => blocker.code)).toContain('PATH_ANCESTOR_SYMLINK')
    expect(dry.plan.findings.map((finding) => finding.code)).toContain('SCAN_PATH_UNSAFE')
    expect(
      dry.plan.findings.filter((finding) => finding.code === 'CLAUDE_COMPONENT_PRESENT'),
    ).toEqual([])
    expect(
      dry.plan.operations
        .filter((operation) => operation.outcome === 'create')
        .map((operation) => operation.path),
    ).toEqual(expect.not.arrayContaining(['.claude/agents/wrkrs-product-manager.md']))
    expectNoLeak(dry.human)
    expectNoLeak(dry.json)
    expectNoReadsThrough(reads, ['.claude'])
  })

  it('never reads a configured role source through a symlinked ancestor during check', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const ports = createTestPorts()
    const prepared = await prepareInit(root, createTestDependencies(), ports)
    if (!prepared.ok) throw prepared.error
    expect((await applyPreparedInit(prepared.value, createTestDependencies(), ports)).status).toBe(
      'applied',
    )
    const outside = outsideTree()
    rmSync(path.join(root, '.wrkrs', 'roles'), { recursive: true })
    symlinkSync(path.join(outside, 'roles'), path.join(root, '.wrkrs', 'roles'))
    const { fs, reads } = recordReads(createTestPorts().fs)

    const check = await checkOutputs(root, fs)
    expect(check.report.ok).toBe(false)
    const codes = check.report.diagnostics.map((diagnostic) => diagnostic.code)
    expect(codes).toContain('CONFIG_ROLE_SOURCE_UNSAFE')
    expect(codes).toContain('OWNED_PATH_UNSAFE')
    expect(
      check.report.diagnostics.find((diagnostic) => diagnostic.code === 'CONFIG_ROLE_SOURCE_UNSAFE')
        ?.path,
    ).toBe('.wrkrs/roles')
    expectNoLeak(check.human)
    expectNoLeak(check.json)
    expectNoReadsThrough(reads, ['.wrkrs/roles'])
  })

  it('never reads a final-path symlink (config, agent) that points outside the repository', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const ports = createTestPorts()
    const prepared = await prepareInit(root, createTestDependencies(), ports)
    if (!prepared.ok) throw prepared.error
    expect((await applyPreparedInit(prepared.value, createTestDependencies(), ports)).status).toBe(
      'applied',
    )
    const outside = outsideTree()
    renameSync(
      path.join(root, '.wrkrs', 'config.yaml'),
      path.join(root, '.wrkrs', 'config.yaml.orig'),
    )
    symlinkSync(path.join(outside, 'config.yaml'), path.join(root, '.wrkrs', 'config.yaml'))
    rmSync(path.join(root, '.claude', 'agents', 'wrkrs-product-manager.md'))
    symlinkSync(
      path.join(outside, 'agents', 'wrkrs-product-manager.md'),
      path.join(root, '.claude', 'agents', 'wrkrs-product-manager.md'),
    )
    const { fs, reads } = recordReads(createTestPorts().fs)

    const check = await checkOutputs(root, fs)
    expect(check.report.ok).toBe(false)
    const codes = check.report.diagnostics.map((diagnostic) => diagnostic.code)
    expect(codes).toContain('CONFIG_PATH_UNSAFE')
    expect(codes).toContain('OWNED_PATH_UNSAFE')
    expectNoLeak(check.human)
    expectNoLeak(check.json)
    expectNoReadsThrough(reads, [])
    expect(reads).not.toContain('.wrkrs/config.yaml')
    expect(reads).not.toContain('.claude/agents/wrkrs-product-manager.md')

    const dry = await dryRunOutputs(root, fs)
    expect(dry.plan.blockers.map((blocker) => blocker.code)).toContain('PATH_TARGET_SYMLINK')
    expectNoLeak(dry.human)
    expectNoLeak(dry.json)
  })

  it('reader rejects symlinked ancestors, escaping ancestors, and symlinked targets with stable codes', async () => {
    const root = makeTempDir()
    cleanup.push(root)
    const outside = makeTempDir('wrkrs-outside-')
    cleanup.push(outside)
    writeFileSync(path.join(outside, 'secret.txt'), OUTSIDE_SENTINEL)
    mkdirSync(path.join(root, 'real'))
    symlinkSync(outside, path.join(root, 'linked'))
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'real', 'link.txt'))
    writeFileSync(path.join(root, 'real', 'file.txt'), 'inside\n')
    const reader = await createRepositoryReader(root, createTestPorts().fs)

    expect(await reader.readText('linked/secret.txt')).toMatchObject({
      ok: false,
      error: { code: 'PATH_ANCESTOR_SYMLINK', ancestor: 'linked' },
    })
    expect(await reader.readText('real/link.txt')).toMatchObject({
      ok: false,
      error: { code: 'PATH_TARGET_SYMLINK' },
    })
    expect(await reader.listDirectory('linked')).toMatchObject({
      ok: false,
      error: { code: 'PATH_TARGET_SYMLINK' },
    })
    expect(await reader.readText('../secret.txt')).toMatchObject({
      ok: false,
      error: { code: 'PATH_INVALID' },
    })
    expect(await reader.readText('real/file.txt')).toEqual({ ok: true, value: 'inside\n' })
    expect(await reader.readText('real/missing.txt')).toEqual({ ok: true, value: null })
    expect(await reader.readText('missing/deeper/file.txt')).toEqual({ ok: true, value: null })
    const resolved = await reader.resolve('linked')
    expect(resolved.ok && resolved.value.stat?.kind).toBe('symlink')
    const failure = await reader.readText('linked/secret.txt')
    expectNoLeak(JSON.stringify(failure))
  })
})
