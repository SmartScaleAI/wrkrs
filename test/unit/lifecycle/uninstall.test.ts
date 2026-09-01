import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MANIFEST_PATH } from '../../../src/core/ownership.js'
import type { InstallPlan, PlanOperation } from '../../../src/core/plan.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import { applyPreparedUninstall, prepareUninstall } from '../../../src/lifecycle/uninstall.js'
import { createTestDependencies, createTestPorts } from '../../helpers/ports.js'
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

/** Installs into a fixture and returns the tree hash taken before installing. */
async function install(
  fixture: FixtureName = 'clean-repository',
): Promise<{ root: string; ports: InitPorts; before: string }> {
  const root = createFixtureRepository(fixture, { commit: true })
  cleanup.push(root)
  const ports = createTestPorts()
  const before = hashTree(root)
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  const result = await applyPreparedInit(prepared.value, createTestDependencies(), ports)
  if (result.status !== 'applied') throw new Error(`install failed: ${result.status}`)
  return { root, ports, before }
}

async function plan(root: string, ports: InitPorts): Promise<InstallPlan> {
  const prepared = await prepareUninstall(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return prepared.value.plan
}

async function apply(root: string, ports: InitPorts) {
  const prepared = await prepareUninstall(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return applyPreparedUninstall(prepared.value, createTestDependencies(), ports)
}

function outcomeOf(plan: InstallPlan, targetPath: string): PlanOperation['outcome'] | undefined {
  return plan.operations.find((operation) => operation.path === targetPath)?.outcome
}

interface ManifestView {
  state: string
  entries: { path: string }[]
  createdDirectories: string[]
}

function manifestOf(root: string): ManifestView {
  return JSON.parse(readFileSync(path.join(root, MANIFEST_PATH), 'utf8')) as ManifestView
}

describe('wrkrs uninstall', () => {
  it('47: planning an uninstall removes nothing', async () => {
    const { root, ports } = await install()
    const before = hashTree(root)
    const built = await plan(root, ports)
    expect(built.operations.some((operation) => operation.outcome === 'remove')).toBe(true)
    expect(hashTree(root)).toBe(before)
  })

  it('57: a clean installation is removed exactly, restoring the pre-init tree', async () => {
    const { root, ports, before } = await install()
    const result = await apply(root, ports)
    expect(result.status).toBe('applied')
    expect(hashTree(root)).toBe(before)
    expect(existsSync(path.join(root, '.wrkrs'))).toBe(false)
    expect(existsSync(path.join(root, '.claude'))).toBe(false)
  })

  it('58: the existing-Claude fixture keeps every pre-existing file and mode', async () => {
    const { root, ports, before } = await install('existing-claude-repository')
    const result = await apply(root, ports)
    expect(result.status).toBe('applied')
    expect(hashTree(root)).toBe(before)
    // Directories wrkrs did not create survive with their entries intact.
    const tree = readTree(root).map((entry) => entry.path)
    expect(tree).toContain('.claude/agents/custom-reviewer.md')
    expect(tree).toContain('.claude/skills/custom-skill/SKILL.md')
    expect(tree).toContain('.claude/commands/custom-command.md')
    expect(tree).toContain('.mcp.json')
    expect(tree).toContain('CLAUDE.md')
  })

  it('59+60: drifted and customized files are preserved and reported', async () => {
    const { root, ports } = await install()
    const managed = path.join(root, '.claude/agents/wrkrs-qa-engineer.md')
    const seeded = path.join(root, '.wrkrs/roles/product-manager.md')
    appendFileSync(managed, '\nhand edit\n')
    appendFileSync(seeded, '\nlocal guidance\n')
    const managedBytes = readFileSync(managed, 'utf8')
    const seededBytes = readFileSync(seeded, 'utf8')

    const built = await plan(root, ports)
    expect(outcomeOf(built, '.claude/agents/wrkrs-qa-engineer.md')).toBe('preserve')
    expect(outcomeOf(built, '.wrkrs/roles/product-manager.md')).toBe('preserve')
    expect(built.findings.some((finding) => finding.code === 'UNINSTALL_PARTIAL')).toBe(true)

    const result = await apply(root, ports)
    expect(result.status).toBe('applied')
    expect(readFileSync(managed, 'utf8')).toBe(managedBytes)
    expect(readFileSync(seeded, 'utf8')).toBe(seededBytes)
  })

  it('61: preserving anything leaves a reduced manifest in partial-uninstall state', async () => {
    const { root, ports } = await install()
    appendFileSync(path.join(root, '.wrkrs/roles/product-manager.md'), '\nlocal guidance\n')
    const result = await apply(root, ports)
    expect(result.status).toBe('applied')

    const manifest = manifestOf(root)
    expect(manifest.state).toBe('partial-uninstall')
    expect(manifest.entries.map((entry) => entry.path)).toEqual(['.wrkrs/roles/product-manager.md'])
    // Only the directories still holding something survive.
    expect(manifest.createdDirectories).toEqual(['.wrkrs', '.wrkrs/roles'])
    expect(existsSync(path.join(root, '.claude'))).toBe(false)
    expect(existsSync(path.join(root, '.wrkrs/config.yaml'))).toBe(false)
  })

  it('62: a retry after a partial uninstall removes what became removable', async () => {
    const { root, ports, before } = await install()
    const seeded = path.join(root, '.wrkrs/roles/product-manager.md')
    const original = readFileSync(seeded, 'utf8')
    appendFileSync(seeded, '\nlocal guidance\n')
    expect((await apply(root, ports)).status).toBe('applied')
    expect(manifestOf(root).state).toBe('partial-uninstall')

    // Configuration is gone; the retry must still plan from the manifest alone.
    expect(existsSync(path.join(root, '.wrkrs/config.yaml'))).toBe(false)
    writeFileSync(seeded, original)
    const retry = await apply(root, ports)
    expect(retry.status).toBe('applied')
    expect(hashTree(root)).toBe(before)
  })

  it('63: a directory wrkrs created that is not empty is left in place and reported', async () => {
    const { root, ports } = await install()
    writeFileSync(path.join(root, '.claude/agents/notes.md'), 'mine\n')
    const result = await apply(root, ports)
    expect(result.status).toBe('applied')
    if (result.status !== 'applied') return
    expect(existsSync(path.join(root, '.claude/agents/notes.md'))).toBe(true)
    expect(result.removedDirectories).not.toContain('.claude/agents')
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'DIRECTORY_RETAINED' && diagnostic.path === '.claude/agents',
      ),
    ).toBe(true)
  })

  it('64: a directory wrkrs did not create is never removed', async () => {
    const { root, ports } = await install()
    // .claude/skills/wrkrs is wrkrs's; .claude/skills is only wrkrs's here
    // because init created it, so use a directory outside the manifest record.
    mkdirSync(path.join(root, 'docs'), { recursive: true })
    writeFileSync(path.join(root, 'docs/notes.md'), 'mine\n')
    const built = await plan(root, ports)
    expect(built.removedDirectories).not.toContain('docs')
    const result = await apply(root, ports)
    expect(result.status).toBe('applied')
    expect(existsSync(path.join(root, 'docs/notes.md'))).toBe(true)
  })

  it('refuses to run outside a Git worktree and without an installation', async () => {
    const outside = makeTempDir('wrkrs-nogit-')
    cleanup.push(outside)
    const noGit = await prepareUninstall(outside, createTestDependencies(), createTestPorts())
    expect(noGit.ok).toBe(false)

    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const before = hashTree(root)
    const missing = await prepareUninstall(root, createTestDependencies(), createTestPorts())
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('OWNERSHIP_MANIFEST_MISSING')
    expect(hashTree(root)).toBe(before)
  })
})
