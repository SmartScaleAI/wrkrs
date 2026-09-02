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

function demoteInstalledConfig(root: string): string {
  const file = path.join(root, CONFIG_PATH)
  const current = readFileSync(file, 'utf8')
  const v1 = current
    .replace('schema version 2', 'schema version 1')
    .replace('schemaVersion: 2', 'schemaVersion: 1')
    .replace(/\nexecution:\n  profile: adaptive\n/, '\n')
    .replace('\ngovernance:', '\n# keep-this-comment\ngovernance:')
  writeFileSync(file, v1)
  return v1
}

describe('configuration schema v2 migration through check and update', () => {
  it('113: check reports a version 1 configuration as migratable and rewrites no byte', async () => {
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
    expect(proposed).toContain('schemaVersion: 2')
    expect(proposed).toContain('profile: adaptive')
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
    expect(parsed.value.sourceSchemaVersion).toBe(2)
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
})
