import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { planToJson } from '../../../src/cli/output/json-reporter.js'
import { MANIFEST_PATH } from '../../../src/core/ownership.js'
import type { InstallPlan, PlanOperation } from '../../../src/core/plan.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import { applyPreparedUpdate, prepareUpdate } from '../../../src/lifecycle/update.js'
import { ANSI_PATTERN } from '../../helpers/cli.js'
import { createTestDependencies, createTestPorts } from '../../helpers/ports.js'
import {
  createFixtureRepository,
  hashTree,
  makeTempDir,
  removeDir,
  type FixtureName,
} from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

async function install(
  fixture: FixtureName = 'clean-repository',
): Promise<{ root: string; ports: InitPorts }> {
  const root = createFixtureRepository(fixture, { commit: true })
  cleanup.push(root)
  const ports = createTestPorts()
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  const result = await applyPreparedInit(prepared.value, createTestDependencies(), ports)
  if (result.status !== 'applied') throw new Error(`install failed: ${result.status}`)
  return { root, ports }
}

async function plan(root: string, ports: InitPorts): Promise<InstallPlan> {
  const prepared = await prepareUpdate(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return prepared.value.plan
}

async function apply(root: string, ports: InitPorts) {
  const prepared = await prepareUpdate(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return applyPreparedUpdate(prepared.value, createTestDependencies(), ports)
}

function outcomeOf(plan: InstallPlan, targetPath: string): PlanOperation['outcome'] | undefined {
  return plan.operations.find((operation) => operation.path === targetPath)?.outcome
}

function paths(plan: InstallPlan, outcome: PlanOperation['outcome']): string[] {
  return plan.operations
    .filter((operation) => operation.outcome === outcome)
    .map((operation) => operation.path)
    .sort()
}

function editConfig(root: string, edit: (text: string) => string): void {
  const file = path.join(root, '.wrkrs', 'config.yaml')
  writeFileSync(file, edit(readFileSync(file, 'utf8')))
}

const AGENT = '.claude/agents/wrkrs-software-engineer.md'
const ROLE = '.wrkrs/roles/software-engineer.md'

describe('wrkrs update preconditions', () => {
  it('42: refuses to run outside a Git worktree and writes nothing', async () => {
    const outside = makeTempDir('wrkrs-nogit-')
    cleanup.push(outside)
    const before = hashTree(outside)
    const result = await prepareUpdate(outside, createTestDependencies(), createTestPorts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('REPOSITORY_NOT_A_GIT_REPOSITORY')
    expect(hashTree(outside)).toBe(before)
  })

  it('43: blocks without an installation, names init, and writes nothing', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const before = hashTree(root)
    const result = await prepareUpdate(root, createTestDependencies(), createTestPorts())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('OWNERSHIP_MANIFEST_MISSING')
      expect(result.error.message).toContain('wrkrs init')
    }
    expect(hashTree(root)).toBe(before)
  })

  it('44: blocks on an unsupported manifest schema version and writes nothing', async () => {
    const { root, ports } = await install()
    const file = path.join(root, MANIFEST_PATH)
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...manifest, schemaVersion: 99 }, null, 2) + '\n')
    const before = hashTree(root)
    const result = await prepareUpdate(root, createTestDependencies(), ports)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('OWNERSHIP_MANIFEST_INVALID')
    expect(hashTree(root)).toBe(before)
  })

  it('45: refuses while a lock or an interrupted journal is present', async () => {
    const { root, ports } = await install()
    writeFileSync(path.join(root, '.wrkrs', '.lock'), '{}\n')
    const locked = await prepareUpdate(root, createTestDependencies(), ports)
    expect(locked.ok).toBe(false)
    if (!locked.ok) expect(locked.error.code).toBe('OWNERSHIP_LOCK_PRESENT')
    rmSync(path.join(root, '.wrkrs', '.lock'))

    writeFileSync(
      path.join(root, '.wrkrs', '.journal.json'),
      JSON.stringify({ schemaVersion: 1, transactionId: 'x', status: 'applying' }, null, 2) + '\n',
    )
    const interrupted = await prepareUpdate(root, createTestDependencies(), ports)
    expect(interrupted.ok).toBe(false)
    if (!interrupted.ok) expect(interrupted.error.code).toBe('OWNERSHIP_TRANSACTION_INTERRUPTED')
  })

  it('47: planning an update writes nothing', async () => {
    const { root, ports } = await install()
    editConfig(root, (text) => text.replace('        - web-frontend\n', ''))
    const before = hashTree(root)
    const built = await plan(root, ports)
    expect(built.operations.some((operation) => operation.outcome === 'replace')).toBe(true)
    expect(hashTree(root)).toBe(before)
  })
})

describe('wrkrs update planning', () => {
  it('48: an installation that is already current plans no change', async () => {
    const { root, ports } = await install()
    const built = await plan(root, ports)
    expect(paths(built, 'create')).toEqual([])
    expect(paths(built, 'replace')).toEqual([])
    expect(paths(built, 'remove')).toEqual([])
    expect(outcomeOf(built, MANIFEST_PATH)).toBe('no-op')
  })

  it('49: adding a specialization replans exactly the engineer role and its projection', async () => {
    const { root, ports } = await install()
    editConfig(root, (text) =>
      text.replace('        - web-frontend\n', '        - web-frontend\n        - go-services\n'),
    )
    const built = await plan(root, ports)
    expect(paths(built, 'replace')).toEqual([AGENT, MANIFEST_PATH, ROLE])
    expect(paths(built, 'remove')).toEqual([])
    expect(paths(built, 'create')).toEqual([])
  })

  it('50: removing a role plans removal of exactly that role file and its projection', async () => {
    const { root, ports } = await install()
    editConfig(root, (text) =>
      text.replace('    - id: qa-engineer\n      source: .wrkrs/roles/qa-engineer.md\n', ''),
    )
    const built = await plan(root, ports)
    expect(paths(built, 'remove')).toEqual([
      '.claude/agents/wrkrs-qa-engineer.md',
      '.wrkrs/roles/qa-engineer.md',
    ])
    expect(paths(built, 'create')).toEqual([])
    // Nothing else is removed. Every remaining projection names the roster it
    // belongs to, so a roster change reprojects them; the manifest records it.
    expect(paths(built, 'replace')).toEqual([
      '.claude/agents/wrkrs-product-designer.md',
      '.claude/agents/wrkrs-product-manager.md',
      '.claude/agents/wrkrs-software-engineer.md',
      '.claude/skills/wrkrs/SKILL.md',
      MANIFEST_PATH,
    ])
  })

  it('51: a drifted managed projection is preserved while the rest still applies', async () => {
    const { root, ports } = await install()
    appendFileSync(path.join(root, '.claude/agents/wrkrs-qa-engineer.md'), '\nhand edit\n')
    const drifted = readFileSync(path.join(root, '.claude/agents/wrkrs-qa-engineer.md'), 'utf8')
    editConfig(root, (text) =>
      text.replace('        - web-frontend\n', '        - web-frontend\n        - rust\n'),
    )
    const built = await plan(root, ports)
    expect(outcomeOf(built, '.claude/agents/wrkrs-qa-engineer.md')).toBe('preserve')
    expect(paths(built, 'replace')).toEqual([AGENT, MANIFEST_PATH, ROLE])
    expect(built.findings.some((finding) => finding.code === 'UPDATE_DRIFT_PRESERVED')).toBe(true)

    const result = await apply(root, ports)
    expect(result.status).toBe('applied')
    expect(readFileSync(path.join(root, '.claude/agents/wrkrs-qa-engineer.md'), 'utf8')).toBe(
      drifted,
    )
    expect(readFileSync(path.join(root, AGENT), 'utf8')).toContain('rust')
  })

  it('52: an undrifted managed projection is replaced and its new hash recorded', async () => {
    const { root, ports } = await install()
    editConfig(root, (text) =>
      text.replace('        - web-frontend\n', '        - web-frontend\n        - rust\n'),
    )
    const built = await plan(root, ports)
    const operation = built.operations.find((candidate) => candidate.path === AGENT)
    expect(operation?.outcome).toBe('replace')
    const result = await apply(root, ports)
    expect(result.status).toBe('applied')
    if (result.status !== 'applied') return
    expect(result.appliedPaths).toContain(AGENT)

    const manifest = JSON.parse(readFileSync(path.join(root, MANIFEST_PATH), 'utf8')) as {
      entries: { path: string; lastAppliedHash: string }[]
    }
    const entry = manifest.entries.find((candidate) => candidate.path === AGENT)
    expect(entry?.lastAppliedHash).toBe(operation?.proposedHash)
  })

  it('53: a customized seeded role file is preserved byte for byte', async () => {
    const { root, ports } = await install()
    const roleFile = path.join(root, '.wrkrs/roles/product-manager.md')
    appendFileSync(roleFile, '\nlocal guidance\n')
    const customized = readFileSync(roleFile, 'utf8')
    const built = await plan(root, ports)
    expect(outcomeOf(built, '.wrkrs/roles/product-manager.md')).toBe('preserve')
    expect(
      built.findings.some((finding) => finding.code === 'UPDATE_CUSTOMIZATION_PRESERVED'),
    ).toBe(true)
    const result = await apply(root, ports)
    expect(result.status).toBe('applied')
    expect(readFileSync(roleFile, 'utf8')).toBe(customized)
  })

  it('54: writes no path that is neither owned nor desired', async () => {
    const { root, ports } = await install('existing-claude-repository')
    const before = new Map(
      [
        'CLAUDE.md',
        '.claude/settings.json',
        '.claude/settings.local.json',
        '.claude/agents/custom-reviewer.md',
        '.claude/skills/custom-skill/SKILL.md',
        '.claude/commands/custom-command.md',
        '.claude/hooks/format.sh',
        '.mcp.json',
      ].map((relative) => [relative, readFileSync(path.join(root, relative), 'utf8')] as const),
    )
    editConfig(root, (text) =>
      text.replace('        - typescript\n', '        - typescript\n        - rust\n'),
    )
    const result = await apply(root, ports)
    expect(result.status).toBe('applied')
    if (result.status !== 'applied') return
    for (const written of [...result.appliedPaths, ...result.removedPaths]) {
      expect(before.has(written)).toBe(false)
    }
    for (const [relative, content] of before) {
      expect(readFileSync(path.join(root, relative), 'utf8')).toBe(content)
    }
  })

  it('55: the plan JSON carries no styling and its digest ignores absolute paths', async () => {
    const first = await install()
    const second = await install()
    for (const { root } of [first, second]) {
      editConfig(root, (text) =>
        text.replace('        - web-frontend\n', '        - web-frontend\n        - rust\n'),
      )
    }
    const a = await plan(first.root, first.ports)
    const b = await plan(second.root, second.ports)
    expect(a.digest).toBe(b.digest)
    expect(first.root).not.toBe(second.root)
    const json = JSON.stringify(planToJson(a))
    expect(ANSI_PATTERN.test(json)).toBe(false)
    expect(json).not.toContain(first.root)
  })

  it('56: a specialization without evidence is kept and reported, never dropped', async () => {
    const { root, ports } = await install()
    editConfig(root, (text) =>
      text.replace(
        '        - web-frontend\n',
        '        - web-frontend\n        - apple-platforms\n',
      ),
    )
    const prepared = await prepareUpdate(root, createTestDependencies(), ports)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const engineer = prepared.value.roster.roles.find((role) => role.id === 'software-engineer')
    const specialization = engineer?.specializations.find(
      (candidate) => candidate.id === 'apple-platforms',
    )
    expect(specialization).toBeDefined()
    expect(specialization?.evidence).toEqual([])
    expect(
      prepared.value.plan.findings.some(
        (finding) => finding.code === 'SPECIALIZATION_WITHOUT_EVIDENCE',
      ),
    ).toBe(true)

    const result = await applyPreparedUpdate(prepared.value, createTestDependencies(), ports)
    expect(result.status).toBe('applied')
    const role = readFileSync(path.join(root, ROLE), 'utf8')
    expect(role).toContain('apple-platforms')
    expect(role).toContain('no supporting signal detected')
  })

  it('adopts a configuration edit that produces exactly what wrkrs would generate', async () => {
    const { root, ports } = await install()
    // Editing config.yaml is the intended workflow for a seeded file. When the
    // edit round-trips through the generator, the update records it as applied
    // rather than treating the file as permanently customized.
    editConfig(root, (text) =>
      text.replace('        - web-frontend\n', '        - web-frontend\n        - rust\n'),
    )
    const result = await apply(root, ports)
    expect(result.status).toBe('applied')

    const manifest = JSON.parse(readFileSync(path.join(root, MANIFEST_PATH), 'utf8')) as {
      entries: { path: string; lastAppliedHash: string }[]
    }
    const entry = manifest.entries.find((candidate) => candidate.path === '.wrkrs/config.yaml')
    expect(entry).toBeDefined()

    // A second update sees no drift and nothing left to do.
    const second = await plan(root, ports)
    expect(outcomeOf(second, '.wrkrs/config.yaml')).toBe('no-op')
    expect(paths(second, 'replace')).toEqual([])
    expect(
      second.findings.some((finding) => finding.code === 'UPDATE_CUSTOMIZATION_PRESERVED'),
    ).toBe(false)
  })

  it('restores an owned file that was deleted outside wrkrs', async () => {
    const { root, ports } = await install()
    rmSync(path.join(root, '.claude/agents/wrkrs-qa-engineer.md'))
    const built = await plan(root, ports)
    expect(outcomeOf(built, '.claude/agents/wrkrs-qa-engineer.md')).toBe('create')
    const result = await apply(root, ports)
    expect(result.status).toBe('applied')
    expect(readFileSync(path.join(root, '.claude/agents/wrkrs-qa-engineer.md'), 'utf8')).toContain(
      'wrkrs-qa-engineer',
    )
  })

  it('never overwrites a namespaced path the manifest does not own', async () => {
    const { root, ports } = await install()
    mkdirSync(path.join(root, '.claude/agents'), { recursive: true })
    const manifestFile = path.join(root, MANIFEST_PATH)
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
      entries: { path: string }[]
    }
    manifest.entries = manifest.entries.filter(
      (entry) => entry.path !== '.claude/agents/wrkrs-qa-engineer.md',
    )
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
    const built = await plan(root, ports)
    expect(outcomeOf(built, '.claude/agents/wrkrs-qa-engineer.md')).toBe('block')
    expect(built.blockers.some((blocker) => blocker.code === 'OWNERSHIP_UNOWNED_TARGET')).toBe(true)
  })

  it('88/91: a project MCP server is referenced without changing .mcp.json', async () => {
    const root = createFixtureRepository('existing-claude-repository', { commit: true })
    cleanup.push(root)
    const mcpPath = path.join(root, '.mcp.json')
    const before = readFileSync(mcpPath)
    const ports = createTestPorts()
    const deps = createTestDependencies()
    const prepared = await prepareInit(root, deps, ports, {
      connections: {
        'work-item-context': {
          provider: 'mcp',
          kind: 'mcp-server',
          server: 'fake-tracker',
          scope: 'project',
        },
      },
    })
    if (!prepared.ok) throw prepared.error
    const result = await applyPreparedInit(prepared.value, deps, ports)
    expect(result.status).toBe('applied')
    expect(readFileSync(mcpPath)).toEqual(before)
    const agent = readFileSync(path.join(root, '.claude/agents/wrkrs-product-manager.md'), 'utf8')
    expect(agent).toContain('fake-tracker')
    expect(agent).not.toContain('mcpServers')
    expect(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).not.toContain('fake-tracker')
    expect(readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).not.toContain(
      'fake-tracker',
    )
  })

  it('98: changing a binding replaces only undrifted wrkrs-owned projections', async () => {
    const { root, ports } = await install()
    editConfig(root, (text) =>
      text.replace(
        'connections: {}',
        'connections:\n  work-item-context:\n    provider: manual\n    kind: manual',
      ),
    )
    const built = await plan(root, ports)
    expect(outcomeOf(built, '.claude/agents/wrkrs-product-manager.md')).toBe('replace')
    for (const target of paths(built, 'replace')) {
      expect(
        target.startsWith('.wrkrs/') ||
          target.startsWith('.claude/agents/wrkrs') ||
          target.startsWith('.claude/skills/wrkrs'),
      ).toBe(true)
    }
    expect(built.operations.some((operation) => operation.path === '.mcp.json')).toBe(false)
  })

  it('99: a customized seeded file stays preserved when a binding changes', async () => {
    const { root, ports } = await install()
    const roleFile = path.join(root, '.wrkrs/roles/product-manager.md')
    appendFileSync(roleFile, '\nlocal guidance\n')
    const customized = readFileSync(roleFile, 'utf8')
    editConfig(root, (text) =>
      text.replace(
        'connections: {}',
        'connections:\n  work-item-context:\n    provider: manual\n    kind: manual',
      ),
    )
    const built = await plan(root, ports)
    expect(outcomeOf(built, '.wrkrs/roles/product-manager.md')).toBe('preserve')
    expect(outcomeOf(built, '.claude/agents/wrkrs-product-manager.md')).toBe('replace')
    const result = await apply(root, ports)
    expect(result.status).toBe('applied')
    expect(readFileSync(roleFile, 'utf8')).toBe(customized)
  })
})
