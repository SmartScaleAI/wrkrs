import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { planToJson } from '../../../src/cli/output/json-reporter.js'
import type { InstallPlan } from '../../../src/core/plan.js'
import { prepareInit } from '../../../src/init/init.js'
import { createFixedClock } from '../../../src/platform/clock.js'
import { createSequentialIds } from '../../../src/platform/ids.js'
import { renderCreateDiff } from '../../../src/planner/diff.js'
import { computePlanDigest } from '../../../src/planner/digest.js'
import { ANSI_PATTERN } from '../../helpers/cli.js'
import { createTestDependencies, createTestPorts } from '../../helpers/ports.js'
import { SECRET_SENTINEL } from '../../helpers/sentinels.js'
import {
  createFixtureRepository,
  hashTree,
  removeDir,
  type FixtureName,
} from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const EXPECTED_CREATES = [
  '.claude/agents/wrkrs-product-designer.md',
  '.claude/agents/wrkrs-product-manager.md',
  '.claude/agents/wrkrs-qa-engineer.md',
  '.claude/agents/wrkrs-software-engineer.md',
  '.claude/skills/wrkrs/SKILL.md',
  '.wrkrs/config.yaml',
  '.wrkrs/manifest.json',
  '.wrkrs/roles/product-designer.md',
  '.wrkrs/roles/product-manager.md',
  '.wrkrs/roles/qa-engineer.md',
  '.wrkrs/roles/software-engineer.md',
  '.wrkrs/schema.json',
]

async function planFor(root: string, ports = createTestPorts()): Promise<InstallPlan> {
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return prepared.value.plan
}

function repo(fixture: FixtureName): string {
  const root = createFixtureRepository(fixture)
  cleanup.push(root)
  return root
}

describe('init plan', () => {
  it('plans exact create operations for the clean fixture without writing', async () => {
    const root = repo('clean-repository')
    const before = hashTree(root)
    const plan = await planFor(root)
    expect(hashTree(root)).toBe(before)
    expect(plan.blockers).toEqual([])
    const creates = plan.operations.filter((operation) => operation.outcome === 'create')
    expect(creates.map((operation) => operation.path)).toEqual(EXPECTED_CREATES)
    for (const operation of creates) {
      expect(operation.expected).toEqual({ kind: 'absent' })
      expect(operation.proposedHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(
        operation.diff?.startsWith(`--- /dev/null\n+++ b/${operation.path}\n@@ -0,0 +1,`),
      ).toBe(true)
      expect(operation.mode).toBe(0o644)
      expect(operation.management === 'managed' || operation.management === 'seeded').toBe(true)
      expect(new TextDecoder().decode(operation.proposedBytes!).endsWith('\n')).toBe(true)
    }
    expect(plan.createdDirectories).toEqual([
      '.claude',
      '.wrkrs',
      '.claude/agents',
      '.claude/skills',
      '.wrkrs/roles',
      '.claude/skills/wrkrs',
    ])
    expect(
      plan.roster.roles
        .find((role) => role.id === 'software-engineer')
        ?.specializations.map((s) => s.id),
    ).toEqual(['javascript', 'typescript', 'web-frontend'])
  })

  it('computes a digest that ignores timestamps and installation ids but not content', async () => {
    const root = repo('clean-repository')
    const first = await planFor(
      root,
      createTestPorts({
        clock: createFixedClock('2026-01-01T00:00:00.000Z'),
        ids: createSequentialIds(),
      }),
    )
    const idsB = createSequentialIds()
    idsB.uuid()
    const second = await planFor(
      root,
      createTestPorts({ clock: createFixedClock('2027-06-01T00:00:00.000Z'), ids: idsB }),
    )
    expect(first.installationId).not.toBe(second.installationId)
    expect(first.createdAt).not.toBe(second.createdAt)
    expect(first.digest).toBe(second.digest)

    const altered: Omit<InstallPlan, 'digest'> = {
      ...first,
      operations: first.operations.map((operation) =>
        operation.path === '.wrkrs/config.yaml'
          ? { ...operation, proposedHash: 'sha256:' + '0'.repeat(64) }
          : operation,
      ),
    }
    expect(computePlanDigest(altered)).not.toBe(first.digest)
  })

  it('serializes to JSON without bytes, ANSI, or absolute-path operation identifiers', async () => {
    const root = repo('existing-claude-repository')
    const plan = await planFor(root)
    const json = JSON.stringify(planToJson(plan))
    expect(json).not.toMatch(ANSI_PATTERN)
    expect(json).not.toContain(SECRET_SENTINEL)
    expect(json).not.toContain('proposedBytes')
    const parsed = planToJson(plan) as {
      operations: { path: string; diff: string | null; proposedHash: string | null }[]
    }
    for (const operation of parsed.operations) {
      expect(operation.path.startsWith('/')).toBe(false)
      expect(operation.path).not.toContain(root)
    }
    expect(parsed.operations.filter((operation) => operation.diff !== null).length).toBe(
      EXPECTED_CREATES.length,
    )
  })

  it('lists every pre-existing Claude component as preserved', async () => {
    const root = repo('existing-claude-repository')
    const plan = await planFor(root)
    const preserved = plan.operations
      .filter((operation) => operation.outcome === 'preserve')
      .map((operation) => operation.path)
    expect(preserved).toEqual([
      '.claude/agents/custom-reviewer.md',
      '.claude/commands/custom-command.md',
      '.claude/hooks/format.sh',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/skills/custom-skill/SKILL.md',
      '.mcp.json',
      'CLAUDE.md',
    ])
    expect(plan.blockers).toEqual([])
    expect(plan.createdDirectories).toEqual(['.wrkrs', '.wrkrs/roles', '.claude/skills/wrkrs'])
    const engineer = plan.roster.roles.find((role) => role.id === 'software-engineer')
    expect(engineer?.specializations.map((s) => s.id)).toEqual([
      'javascript',
      'typescript',
      'node-backend',
    ])
  })

  it('blocks a namespaced target with different content and reuses identical content', async () => {
    const root = repo('clean-repository')
    const agent = path.join(root, '.claude', 'agents')
    mkdirSync(agent, { recursive: true })
    writeFileSync(
      path.join(agent, 'wrkrs-product-manager.md'),
      '---\nname: wrkrs-product-manager\n---\nsomething else\n',
    )
    const blocked = await planFor(root)
    expect(blocked.blockers.map((blocker) => blocker.code)).toEqual(['COMPONENT_CONTENT_DIFFERS'])
    expect(
      blocked.operations.find(
        (operation) => operation.path === '.claude/agents/wrkrs-product-manager.md',
      )?.outcome,
    ).toBe('block')

    const reference = await planFor(repo('clean-repository'))
    const bytes = reference.operations.find(
      (operation) => operation.path === '.claude/agents/wrkrs-product-manager.md',
    )!.proposedBytes!
    writeFileSync(path.join(agent, 'wrkrs-product-manager.md'), bytes)
    const reused = await planFor(root)
    expect(reused.blockers).toEqual([])
    const operation = reused.operations.find(
      (candidate) => candidate.path === '.claude/agents/wrkrs-product-manager.md',
    )!
    expect(operation.outcome).toBe('reuse')
    expect(operation.management).toBe('referenced')
    const manifest = reused.operations.find(
      (candidate) => candidate.path === '.wrkrs/manifest.json',
    )!
    expect(new TextDecoder().decode(manifest.proposedBytes!)).toContain(
      '"management": "referenced"',
    )
  })

  it('blocks symlinked targets and symlinked ancestors', async () => {
    const root = repo('clean-repository')
    mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
    symlinkSync(
      path.join(root, 'README.md'),
      path.join(root, '.claude', 'agents', 'wrkrs-qa-engineer.md'),
    )
    const target = await planFor(root)
    expect(target.blockers.map((blocker) => `${blocker.code}:${blocker.path}`)).toEqual([
      'PATH_TARGET_SYMLINK:.claude/agents/wrkrs-qa-engineer.md',
    ])

    const other = repo('clean-repository')
    mkdirSync(path.join(other, '.claude'))
    symlinkSync(path.join(other, 'src'), path.join(other, '.claude', 'skills'))
    const ancestor = await planFor(other)
    expect(ancestor.blockers.map((blocker) => `${blocker.code}:${blocker.path}`)).toEqual([
      'PATH_ANCESTOR_SYMLINK:.claude/skills/wrkrs/SKILL.md',
    ])
  })

  it('blocks a .wrkrs directory without a valid manifest and interrupted transactions', async () => {
    const root = repo('clean-repository')
    mkdirSync(path.join(root, '.wrkrs'))
    writeFileSync(path.join(root, '.wrkrs', 'config.yaml'), 'schemaVersion: 1\n')
    const missing = await planFor(root)
    expect(missing.blockers.map((blocker) => blocker.code)).toContain('OWNERSHIP_MANIFEST_MISSING')

    writeFileSync(path.join(root, '.wrkrs', 'manifest.json'), '{"schemaVersion": 1}')
    const invalid = await planFor(root)
    expect(invalid.blockers.map((blocker) => blocker.code)).toContain('OWNERSHIP_MANIFEST_INVALID')

    writeFileSync(path.join(root, '.wrkrs', '.journal.json'), '{}')
    writeFileSync(path.join(root, '.wrkrs', '.lock'), '{}')
    const interrupted = await planFor(root)
    expect(interrupted.blockers.map((blocker) => blocker.code)).toContain(
      'OWNERSHIP_TRANSACTION_INTERRUPTED',
    )
    expect(interrupted.blockers.map((blocker) => blocker.code)).toContain('OWNERSHIP_LOCK_PRESENT')
  })

  it('blocks case-insensitive collisions with existing paths', async () => {
    const root = repo('clean-repository')
    mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
    writeFileSync(path.join(root, '.claude', 'agents', 'WRKRS-Product-Manager.md'), 'shouting\n')
    const plan = await planFor(root)
    expect(plan.blockers.map((blocker) => `${blocker.code}:${blocker.path}`)).toEqual([
      'PATH_CASE_COLLISION:.claude/agents/wrkrs-product-manager.md',
    ])
  })

  it('produces a no-op plan for an unchanged installation and blocks partial ones', async () => {
    const root = repo('clean-repository')
    const { applyPreparedInit } = await import('../../../src/init/init.js')
    const ports = createTestPorts()
    const prepared = await prepareInit(root, createTestDependencies(), ports)
    if (!prepared.ok) throw prepared.error
    const applied = await applyPreparedInit(prepared.value, createTestDependencies(), ports)
    expect(applied.status).toBe('applied')

    const rerun = await planFor(root)
    expect(rerun.blockers).toEqual([])
    expect(rerun.operations.filter((operation) => operation.outcome === 'create')).toEqual([])
    expect(rerun.operations.filter((operation) => operation.outcome === 'no-op').length).toBe(
      EXPECTED_CREATES.length - 1,
    )

    writeFileSync(
      path.join(root, '.wrkrs', 'roles', 'qa-engineer.md'),
      '---\nid: qa-engineer\n---\ncustomized\n',
    )
    const customized = await planFor(root)
    expect(customized.blockers).toEqual([])
    expect(
      customized.operations.find((operation) => operation.path === '.wrkrs/roles/qa-engineer.md')
        ?.outcome,
    ).toBe('preserve')

    writeFileSync(
      path.join(root, '.claude', 'agents', 'wrkrs-qa-engineer.md'),
      '---\nname: wrkrs-qa-engineer\n---\nedited\n',
    )
    const drifted = await planFor(root)
    expect(drifted.blockers.map((blocker) => blocker.code)).toEqual(['CUSTOMIZATION_MANAGED_DRIFT'])
  })
})

describe('renderCreateDiff', () => {
  it('renders a unified diff against /dev/null', () => {
    expect(renderCreateDiff('a/b.txt', 'one\ntwo\n')).toBe(
      '--- /dev/null\n+++ b/a/b.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n',
    )
    expect(renderCreateDiff('x', 'no newline')).toBe(
      '--- /dev/null\n+++ b/x\n@@ -0,0 +1,1 @@\n+no newline\n\\ No newline at end of file\n',
    )
    expect(renderCreateDiff('empty', '')).toBe('--- /dev/null\n+++ b/empty\n@@ -0,0 +1,0 @@\n')
  })
})
