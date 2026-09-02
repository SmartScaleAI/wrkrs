import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MANIFEST_PATH } from '../../../src/core/ownership.js'
import type { InstallPlan, PlanOperation } from '../../../src/core/plan.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import { prepareUninstall } from '../../../src/lifecycle/uninstall.js'
import { prepareUpdate } from '../../../src/lifecycle/update.js'
import { createTestDependencies, createTestPorts } from '../../helpers/ports.js'
import { createFixtureRepository, hashTree, removeDir } from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const AGENT = '.claude/agents/wrkrs-qa-engineer.md'

async function install(): Promise<{ root: string; ports: InitPorts }> {
  const root = createFixtureRepository('clean-repository', { commit: true })
  cleanup.push(root)
  const ports = createTestPorts()
  const prepared = await prepareInit(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  const result = await applyPreparedInit(prepared.value, createTestDependencies(), ports)
  if (result.status !== 'applied') throw new Error(`install failed: ${result.status}`)
  return { root, ports }
}

async function updatePlan(root: string, ports: InitPorts): Promise<InstallPlan> {
  const prepared = await prepareUpdate(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return prepared.value.plan
}

async function uninstallPlan(root: string, ports: InitPorts): Promise<InstallPlan> {
  const prepared = await prepareUninstall(root, createTestDependencies(), ports)
  if (!prepared.ok) throw prepared.error
  return prepared.value.plan
}

function operation(plan: InstallPlan, target: string): PlanOperation | undefined {
  return plan.operations.find((candidate) => candidate.path === target)
}

/** Rewrites the manifest in place, keeping it a valid document. */
function patchManifest(root: string, patch: (value: ManifestView) => void): void {
  const file = path.join(root, MANIFEST_PATH)
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as ManifestView
  patch(manifest)
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
}

interface ManifestView {
  state: string
  entries: {
    path: string
    kind: string
    management: string
    sourceId: string
    sourceVersion: number
    lastAppliedHash: string
  }[]
  createdDirectories: string[]
}

describe('lifecycle planning safety', () => {
  it('blocks when an owned path became a symlink, and writes nothing', async () => {
    const { root, ports } = await install()
    const target = path.join(root, AGENT)
    rmSync(target)
    symlinkSync(path.join(root, 'package.json'), target)
    const before = hashTree(root)

    const update = await updatePlan(root, ports)
    expect(operation(update, AGENT)?.outcome).toBe('block')
    expect(update.blockers.some((blocker) => blocker.code === 'PATH_TARGET_SYMLINK')).toBe(true)

    const uninstall = await uninstallPlan(root, ports)
    expect(operation(uninstall, AGENT)?.outcome).toBe('block')
    expect(uninstall.blockers.some((blocker) => blocker.code === 'PATH_TARGET_SYMLINK')).toBe(true)
    // A blocked uninstall still keeps the entry, so nothing is silently dropped.
    expect(hashTree(root)).toBe(before)
  })

  it('blocks when an owned path became a directory', async () => {
    const { root, ports } = await install()
    rmSync(path.join(root, AGENT))
    mkdirSync(path.join(root, AGENT))

    const update = await updatePlan(root, ports)
    expect(update.blockers.some((blocker) => blocker.code === 'PATH_TARGET_NOT_A_FILE')).toBe(true)
    const uninstall = await uninstallPlan(root, ports)
    expect(uninstall.blockers.some((blocker) => blocker.code === 'PATH_TARGET_NOT_A_FILE')).toBe(
      true,
    )
  })

  it('never modifies or removes a referenced entry', async () => {
    const { root, ports } = await install()
    // A referenced entry records a pre-existing file wrkrs reused but does not own.
    writeFileSync(path.join(root, 'NOTES.md'), 'mine\n')
    patchManifest(root, (manifest) => {
      manifest.entries.push({
        path: 'NOTES.md',
        kind: 'file',
        management: 'referenced',
        sourceId: 'wrkrs/reference',
        sourceVersion: 1,
        lastAppliedHash: 'sha256:' + '0'.repeat(64),
      })
    })

    const update = await updatePlan(root, ports)
    expect(operation(update, 'NOTES.md')?.outcome).toBe('preserve')

    const uninstall = await uninstallPlan(root, ports)
    expect(operation(uninstall, 'NOTES.md')?.outcome).toBe('preserve')
    // Because something is preserved, the manifest is reduced, not removed.
    expect(operation(uninstall, MANIFEST_PATH)?.outcome).toBe('replace')
    expect(uninstall.removedDirectories).not.toContain('.wrkrs')
    expect(readFileSync(path.join(root, 'NOTES.md'), 'utf8')).toBe('mine\n')
  })

  it('drops an owned entry that is already absent without planning a removal', async () => {
    const { root, ports } = await install()
    patchManifest(root, (manifest) => {
      manifest.entries.push({
        path: '.wrkrs/gone.md',
        kind: 'file',
        management: 'managed',
        sourceId: 'wrkrs/gone',
        sourceVersion: 1,
        lastAppliedHash: 'sha256:' + '0'.repeat(64),
      })
    })

    const update = await updatePlan(root, ports)
    expect(operation(update, '.wrkrs/gone.md')?.outcome).toBe('no-op')
    expect(update.operations.some((candidate) => candidate.outcome === 'remove')).toBe(false)
    // The stale record is dropped from the manifest the update writes.
    const manifestOperation = operation(update, MANIFEST_PATH)
    expect(manifestOperation?.outcome).toBe('replace')
    expect(manifestOperation?.diff).toContain('-      "path": ".wrkrs/gone.md"')

    const uninstall = await uninstallPlan(root, ports)
    expect(operation(uninstall, '.wrkrs/gone.md')?.outcome).toBe('no-op')
  })

  it('an uninstall that removes everything plans the manifest removal last', async () => {
    const { root, ports } = await install()
    const plan = await uninstallPlan(root, ports)
    expect(operation(plan, MANIFEST_PATH)?.outcome).toBe('remove')
    // Deepest directories first, and .wrkrs itself only once nothing remains.
    expect(plan.removedDirectories).toEqual([
      '.claude/skills/wrkrs',
      '.claude/agents',
      '.claude/skills',
      '.wrkrs/roles',
      '.claude',
      '.wrkrs',
    ])
  })

  it('keeps the update digest stable while ignoring timestamps and identifiers', async () => {
    const { root, ports } = await install()
    const first = await updatePlan(root, ports)
    const second = await updatePlan(root, ports)
    expect(first.digest).toBe(second.digest)
    expect(first.installationId).toBe(second.installationId)
  })
})
