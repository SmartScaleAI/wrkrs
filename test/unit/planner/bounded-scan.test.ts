import { mkdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { InstallPlan } from '../../../src/core/plan.js'
import { prepareInit, type InitDependencies } from '../../../src/init/init.js'
import { MAX_INDEXED_ENTRIES } from '../../../src/repository/snapshot.js'
import { createTestDependencies, createTestPorts } from '../../helpers/ports.js'
import { createFixtureRepository, hashTree, removeDir } from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const TARGET = '.claude/agents/wrkrs-product-manager.md'
const ALIAS = '.claude/agents/WRKRS-Product-Manager.md'

function crowdedRepository(count: number): string {
  const root = createFixtureRepository('clean-repository', { commit: true })
  cleanup.push(root)
  const agents = path.join(root, '.claude', 'agents')
  mkdirSync(agents, { recursive: true })
  for (let index = 0; index < count; index += 1) {
    // Lexically before "wrkrs-", so a bounded index fills up before reaching the target.
    writeFileSync(
      path.join(agents, `a-${String(index).padStart(5, '0')}.md`),
      `---\nname: a-${index}\n---\n`,
    )
  }
  return root
}

async function plan(
  root: string,
  deps: InitDependencies = createTestDependencies(),
): Promise<InstallPlan> {
  const prepared = await prepareInit(root, deps, createTestPorts())
  if (!prepared.ok) throw prepared.error
  return prepared.value.plan
}

function operation(installPlan: InstallPlan, target: string) {
  return installPlan.operations.find((candidate) => candidate.path === target)
}

describe('bounded scans keep the dry run exact', () => {
  it('classifies an existing namespaced target correctly behind more than 5,000 earlier entries', async () => {
    const count = MAX_INDEXED_ENTRIES + 200
    const root = crowdedRepository(count)
    writeFileSync(path.join(root, ...TARGET.split('/')), 'existing content that differs\n')
    const before = hashTree(root)
    const result = await plan(root)
    expect(result.findings.map((finding) => finding.code)).toContain('SCAN_INDEX_TRUNCATED')
    expect(result.findings.map((finding) => finding.code)).toContain('CLAUDE_COMPONENTS_TRUNCATED')
    expect(
      result.findings.filter((finding) => finding.code === 'CLAUDE_COMPONENT_PRESENT').length,
    ).toBeGreaterThan(500)
    expect(operation(result, TARGET)?.outcome).toBe('block')
    expect(operation(result, TARGET)?.blocker?.code).toBe('COMPONENT_CONTENT_DIFFERS')
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['COMPONENT_CONTENT_DIFFERS'])
    expect(
      result.operations.some(
        (candidate) => candidate.outcome === 'create' && candidate.path === TARGET,
      ),
    ).toBe(false)
    expect(hashTree(root)).toBe(before)
  }, 120_000)

  it('blocks a case-only collision that sits after the truncation boundary', async () => {
    const root = crowdedRepository(60)
    writeFileSync(path.join(root, ...ALIAS.split('/')), 'shouting\n')
    const before = hashTree(root)
    const result = await plan(root, {
      ...createTestDependencies(),
      analyzeOptions: { indexLimit: 20 },
    })
    expect(result.findings.map((finding) => finding.code)).toContain('SCAN_INDEX_TRUNCATED')
    expect(operation(result, TARGET)?.outcome).toBe('block')
    expect(operation(result, TARGET)?.blocker?.code).toBe('PATH_CASE_COLLISION')
    expect(operation(result, TARGET)?.blocker?.path).toBe(TARGET)
    expect(hashTree(root)).toBe(before)
  })

  it('reuses an identical namespaced target after the truncation boundary instead of creating it', async () => {
    const root = crowdedRepository(60)
    const reference = await plan(createFixtureRepository('clean-repository'))
    cleanup.push(reference.repositoryRoot)
    writeFileSync(
      path.join(root, ...TARGET.split('/')),
      operation(reference, TARGET)!.proposedBytes!,
    )
    const result = await plan(root, {
      ...createTestDependencies(),
      analyzeOptions: { indexLimit: 20 },
    })
    expect(result.blockers).toEqual([])
    expect(operation(result, TARGET)?.outcome).toBe('reuse')
  })

  it('blocks with a stable incomplete-scan conflict when a parent listing cannot be completed', async () => {
    const root = crowdedRepository(30)
    const before = hashTree(root)
    const result = await plan(root, {
      ...createTestDependencies(),
      analyzeOptions: { listingLimit: 10 },
    })
    const conflicts = result.blockers.filter((blocker) => blocker.code === 'SCAN_INCOMPLETE')
    expect(conflicts.length).toBeGreaterThan(0)
    expect(conflicts.map((blocker) => blocker.path)).toContain(TARGET)
    expect(
      result.operations
        .filter((candidate) => candidate.outcome === 'create')
        .map((candidate) => candidate.path),
    ).not.toContain(TARGET)
    expect(hashTree(root)).toBe(before)
  })

  it('blocks when an existing ancestor is only reachable through a differently cased name', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    mkdirSync(path.join(root, '.Claude', 'agents'), { recursive: true })
    const result = await plan(root)
    expect(result.blockers.map((blocker) => blocker.code)).toContain('PATH_CASE_COLLISION')
    expect(
      result.operations
        .filter((candidate) => candidate.outcome === 'create')
        .map((candidate) => candidate.path),
    ).not.toContain(TARGET)
  })
})
