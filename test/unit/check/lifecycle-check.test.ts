import { readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runCheck, type CheckReport } from '../../../src/check/check.js'
import { parseManifestDocument } from '../../../src/config/load.js'
import { MANIFEST_PATH } from '../../../src/core/ownership.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import { applyPreparedUninstall, prepareUninstall } from '../../../src/lifecycle/uninstall.js'
import { applyPreparedUpdate, prepareUpdate } from '../../../src/lifecycle/update.js'
import { createTestDependencies, createTestPorts } from '../../helpers/ports.js'
import { createFixtureRepository, FIXTURES_ROOT, hashTree, removeDir } from '../../helpers/temp.js'

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

describe('check after a lifecycle command', () => {
  it('69: reports a partial-uninstall manifest instead of a healthy installation', async () => {
    const { root, ports } = await install()
    writeFileSync(
      path.join(root, '.wrkrs/roles/product-manager.md'),
      readFileSync(path.join(root, '.wrkrs/roles/product-manager.md'), 'utf8') + '\nlocal\n',
    )
    const prepared = await prepareUninstall(root, createTestDependencies(), ports)
    if (!prepared.ok) throw prepared.error
    const result = await applyPreparedUninstall(prepared.value, createTestDependencies(), ports)
    expect(result.status).toBe('applied')

    const report = await check(root, ports)
    expect(codes(report)).toContain('MANIFEST_PARTIAL_UNINSTALL')
    // Configuration is gone on purpose, so its absence is not an error.
    expect(codes(report)).toContain('CONFIG_REMOVED_BY_UNINSTALL')
    expect(codes(report)).not.toContain('CONFIG_MISSING')
    expect(report.summary.errors).toBe(0)

    const diagnostic = report.diagnostics.find(
      (candidate) => candidate.code === 'MANIFEST_PARTIAL_UNINSTALL',
    )
    expect(diagnostic?.severity).toBe('warning')
    expect(diagnostic?.path).toBe(MANIFEST_PATH)
    expect(diagnostic?.remediation).toContain('wrkrs uninstall')
  })

  it('70: reads a version 1 manifest, reports it as migratable, and does not migrate it', async () => {
    const { root, ports } = await install()
    const file = path.join(root, MANIFEST_PATH)
    const current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    delete current['state']
    const legacy = JSON.stringify({ ...current, schemaVersion: 1 }, null, 2) + '\n'
    writeFileSync(file, legacy)

    const before = hashTree(root)
    const report = await check(root, ports)
    expect(codes(report)).toContain('MANIFEST_MIGRATION_AVAILABLE')
    expect(report.summary.errors).toBe(0)
    const diagnostic = report.diagnostics.find(
      (candidate) => candidate.code === 'MANIFEST_MIGRATION_AVAILABLE',
    )
    expect(diagnostic?.severity).toBe('warning')
    expect(diagnostic?.remediation).toContain('wrkrs update')
    // check never rewrites the document it read.
    expect(readFileSync(file, 'utf8')).toBe(legacy)
    expect(hashTree(root)).toBe(before)
  })

  it('70: `wrkrs update` migrates a version 1 manifest to the current format', async () => {
    const { root, ports } = await install()
    const file = path.join(root, MANIFEST_PATH)
    const current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    delete current['state']
    writeFileSync(file, JSON.stringify({ ...current, schemaVersion: 1 }, null, 2) + '\n')

    const prepared = await prepareUpdate(root, createTestDependencies(), ports)
    if (!prepared.ok) throw prepared.error
    const result = await applyPreparedUpdate(prepared.value, createTestDependencies(), ports)
    expect(result.status).toBe('applied')

    const migrated = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(migrated['schemaVersion']).toBe(2)
    expect(migrated['state']).toBe('installed')
    expect(codes(await check(root, ports))).not.toContain('MANIFEST_MIGRATION_AVAILABLE')
  })

  it('70: the committed version 1 fixture still parses and migrates', () => {
    const text = readFileSync(
      path.join(FIXTURES_ROOT, 'legacy-manifest', 'manifest-v1.json'),
      'utf8',
    )
    const parsed = parseManifestDocument(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.sourceSchemaVersion).toBe(1)
    expect(parsed.value.migrated).toBe(true)
    expect(parsed.value.manifest.state).toBe('installed')
    expect(parsed.value.manifest.schemaVersion).toBe(2)
  })

  it('71: check passes after a successful update', async () => {
    const { root, ports } = await install()
    const configFile = path.join(root, '.wrkrs/config.yaml')
    writeFileSync(
      configFile,
      readFileSync(configFile, 'utf8').replace(
        '        - web-frontend\n',
        '        - web-frontend\n        - rust\n',
      ),
    )
    const prepared = await prepareUpdate(root, createTestDependencies(), ports)
    if (!prepared.ok) throw prepared.error
    const result = await applyPreparedUpdate(prepared.value, createTestDependencies(), ports)
    expect(result.status).toBe('applied')

    const report = await check(root, ports)
    expect(report.ok).toBe(true)
    expect(report.summary.errors).toBe(0)
    expect(codes(report)).toContain('OWNERSHIP_OK')
    expect(codes(report)).toContain('CLAUDE_ADAPTER_OK')
  })

  it('an update that preserved drift still reports that drift afterwards', async () => {
    const { root, ports } = await install()
    const agent = path.join(root, '.claude/agents/wrkrs-qa-engineer.md')
    writeFileSync(agent, readFileSync(agent, 'utf8') + '\nhand edit\n')
    const prepared = await prepareUpdate(root, createTestDependencies(), ports)
    if (!prepared.ok) throw prepared.error
    const result = await applyPreparedUpdate(prepared.value, createTestDependencies(), ports)
    expect(result.status).toBe('applied')

    const report = await check(root, ports)
    const drift = report.diagnostics.find((candidate) => candidate.code === 'MANAGED_FILE_DRIFT')
    expect(drift?.path).toBe('.claude/agents/wrkrs-qa-engineer.md')
  })
})
