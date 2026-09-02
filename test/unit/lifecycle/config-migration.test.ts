import { readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runCheck, type CheckReport } from '../../../src/check/check.js'
import { parseConfigDocument } from '../../../src/config/load.js'
import { CONFIG_PATH } from '../../../src/core/ownership.js'
import { FileSystemError } from '../../../src/core/ports.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import { applyPreparedUpdate, prepareUpdate } from '../../../src/lifecycle/update.js'
import {
  createTestDependencies,
  createTestPorts,
  interceptFileSystem,
} from '../../helpers/ports.js'
import { createFixtureRepository, hashTree, removeDir } from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

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

function check(root: string, ports: InitPorts): Promise<CheckReport> {
  const deps = createTestDependencies()
  return runCheck(
    {
      cwd: root,
      wrkrsVersion: deps.wrkrsVersion,
      adapters: deps.adapters,
      providers: deps.providers,
    },
    ports,
  )
}

function codes(report: CheckReport): string[] {
  return report.diagnostics.map((diagnostic) => diagnostic.code)
}

function demoteInstalledConfig(root: string, to: 1 | 2 = 1): string {
  const file = path.join(root, CONFIG_PATH)
  const current = readFileSync(file, 'utf8')
  let demoted = current
    .replace('schema version 3', `schema version ${to}`)
    .replace('schemaVersion: 3', `schemaVersion: ${to}`)
    .replace(/\nconnections: \{\}\n/, '\nproviders: {}\n')
    .replace('\ngovernance:', '\n# keep-this-comment\ngovernance:')
  if (to === 1) {
    demoted = demoted.replace(/\nexecution:\n  profile: adaptive\n/, '\n')
  }
  writeFileSync(file, demoted)
  return demoted
}

describe('configuration schema v2 migration through check and update', () => {
  it('113: check reports a version 1 and a version 2 configuration as migratable and rewrites no byte', async () => {
    const { root, ports } = await install()
    const legacy = demoteInstalledConfig(root)
    const before = hashTree(root)
    const report = await check(root, ports)
    expect(codes(report)).toContain('CONFIG_MIGRATION_AVAILABLE')
    expect(report.summary.errors).toBe(0)
    const diagnostic = report.diagnostics.find(
      (candidate) => candidate.code === 'CONFIG_MIGRATION_AVAILABLE',
    )
    expect(diagnostic?.severity).toBe('warning')
    expect(diagnostic?.path).toBe(CONFIG_PATH)
    expect(diagnostic?.remediation).toContain('wrkrs update')
    expect(diagnostic?.remediation).toContain('check never migrates')
    expect(readFileSync(path.join(root, CONFIG_PATH), 'utf8')).toBe(legacy)
    expect(hashTree(root)).toBe(before)

    const again = await install()
    const v2 = demoteInstalledConfig(again.root, 2)
    const beforeV2 = hashTree(again.root)
    const reportV2 = await check(again.root, again.ports)
    expect(codes(reportV2)).toContain('CONFIG_MIGRATION_AVAILABLE')
    expect(reportV2.summary.errors).toBe(0)
    expect(readFileSync(path.join(again.root, CONFIG_PATH), 'utf8')).toBe(v2)
    expect(hashTree(again.root)).toBe(beforeV2)
  })

  it('118: update --dry-run on an unmigrated configuration shows the migration diff and writes nothing', async () => {
    const { root, ports } = await install()
    const legacy = demoteInstalledConfig(root)
    const before = hashTree(root)
    const prepared = await prepareUpdate(root, createTestDependencies(), ports)
    if (!prepared.ok) throw prepared.error
    const operation = prepared.value.plan.operations.find(
      (candidate) => candidate.path === CONFIG_PATH,
    )
    expect(operation?.outcome).toBe('replace')
    const proposed = operation?.proposedBytes
      ? new TextDecoder().decode(operation.proposedBytes)
      : ''
    expect(proposed).toContain('schemaVersion: 3')
    expect(proposed).toContain('profile: adaptive')
    expect(proposed).toContain('connections:')
    expect(proposed).toContain('# keep-this-comment')
    expect(hashTree(root)).toBe(before)
    expect(readFileSync(path.join(root, CONFIG_PATH), 'utf8')).toBe(legacy)
  })

  it('119: update --yes applies the migration; a later validation failure rolls back exact prior bytes', async () => {
    const { root, ports } = await install()
    const legacy = demoteInstalledConfig(root)

    const prepared = await prepareUpdate(root, createTestDependencies(), ports)
    if (!prepared.ok) throw prepared.error
    const result = await applyPreparedUpdate(prepared.value, createTestDependencies(), ports)
    expect(result.status).toBe('applied')

    const applied = readFileSync(path.join(root, CONFIG_PATH), 'utf8')
    expect(applied).toContain('# keep-this-comment')
    const parsed = parseConfigDocument(applied)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.sourceSchemaVersion).toBe(3)
    expect(parsed.value.config.execution.profile).toBe('adaptive')
    expect(codes(await check(root, ports))).not.toContain('CONFIG_MIGRATION_AVAILABLE')

    writeFileSync(path.join(root, CONFIG_PATH), legacy)
    const before = readFileSync(path.join(root, CONFIG_PATH), 'utf8')
    let failed = false
    const fs = interceptFileSystem(ports.fs, {
      bound: {
        rename: async (args, next, directory) => {
          if (directory.relativePath === '.wrkrs' && args[1] === 'manifest.json' && !failed) {
            failed = true
            throw new FileSystemError('EIO', args[1], 'injected publication failure')
          }
          return next(...args)
        },
      },
    })
    const failingPorts = createTestPorts({ fs })
    const retry = await prepareUpdate(root, createTestDependencies(), failingPorts)
    if (!retry.ok) throw retry.error
    const rolled = await applyPreparedUpdate(retry.value, createTestDependencies(), failingPorts)
    expect(rolled.status === 'rolled-back' || rolled.status === 'rollback-incomplete').toBe(true)
    expect(readFileSync(path.join(root, CONFIG_PATH), 'utf8')).toBe(before)
  })

  it('later update of a migrated configuration keeps comment-preserving bytes', async () => {
    const { root, ports } = await install()
    demoteInstalledConfig(root)
    const migrated = await prepareUpdate(root, createTestDependencies(), ports)
    if (!migrated.ok) throw migrated.error
    const applied = await applyPreparedUpdate(migrated.value, createTestDependencies(), ports)
    expect(applied.status).toBe('applied')
    const afterMigration = readFileSync(path.join(root, CONFIG_PATH), 'utf8')
    expect(afterMigration).toContain('# keep-this-comment')

    const later = await prepareUpdate(root, createTestDependencies(), ports)
    if (!later.ok) throw later.error
    const operation = later.value.plan.operations.find(
      (candidate) => candidate.path === CONFIG_PATH,
    )
    expect(operation?.outcome).toBe('no-op')
    const again = await applyPreparedUpdate(later.value, createTestDependencies(), ports)
    expect(again.status).toBe('applied')
    expect(readFileSync(path.join(root, CONFIG_PATH), 'utf8')).toBe(afterMigration)
  })

  it('preserves owner comments added after a comment-preserving migration', async () => {
    const { root, ports } = await install()
    demoteInstalledConfig(root)
    const migrated = await prepareUpdate(root, createTestDependencies(), ports)
    if (!migrated.ok) throw migrated.error
    expect(
      (await applyPreparedUpdate(migrated.value, createTestDependencies(), ports)).status,
    ).toBe('applied')
    const file = path.join(root, CONFIG_PATH)
    writeFileSync(file, `${readFileSync(file, 'utf8')}# owner-note\n`)
    const customized = readFileSync(file, 'utf8')
    const later = await prepareUpdate(root, createTestDependencies(), ports)
    if (!later.ok) throw later.error
    const operation = later.value.plan.operations.find(
      (candidate) => candidate.path === CONFIG_PATH,
    )
    expect(operation?.outcome).toBe('preserve')
    expect(
      later.value.plan.findings.some(
        (finding) => finding.code === 'UPDATE_CUSTOMIZATION_PRESERVED',
      ),
    ).toBe(true)
    expect((await applyPreparedUpdate(later.value, createTestDependencies(), ports)).status).toBe(
      'applied',
    )
    expect(readFileSync(file, 'utf8')).toBe(customized)
  })
})
