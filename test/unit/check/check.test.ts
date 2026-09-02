import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runCheck, type CheckReport } from '../../../src/check/check.js'
import { checkToJson } from '../../../src/cli/output/json-reporter.js'
import { applyPreparedInit, prepareInit, type InitPorts } from '../../../src/init/init.js'
import { ANSI_PATTERN } from '../../helpers/cli.js'
import {
  createTestDependencies,
  createTestEnvironment,
  createTestPorts,
} from '../../helpers/ports.js'
import { createFixtureRepository, hashTree, makeTempDir, removeDir } from '../../helpers/temp.js'

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

describe('wrkrs check', () => {
  it('passes on a healthy installation and is read-only', async () => {
    const { root, ports } = await install()
    const before = hashTree(root)
    const report = await check(root, ports)
    expect(report.ok).toBe(true)
    expect(report.summary.errors).toBe(0)
    for (const code of [
      'CONFIG_OK',
      'MANIFEST_OK',
      'OWNERSHIP_OK',
      'TRANSACTION_OK',
      'CLAUDE_ADAPTER_OK',
      'ENV_NODE_VERSION_OK',
      'ENV_GIT_OK',
      'REPOSITORY_OK',
    ]) {
      expect(codes(report)).toContain(code)
    }
    expect(hashTree(root)).toBe(before)
  })

  it('reports managed drift with the exact path and does not repair it', async () => {
    const { root, ports } = await install()
    const target = path.join(root, '.claude', 'agents', 'wrkrs-qa-engineer.md')
    appendFileSync(target, '\nlocal tweak\n')
    const before = hashTree(root)
    const report = await check(root, ports)
    expect(report.ok).toBe(false)
    const drift = report.diagnostics.find((diagnostic) => diagnostic.code === 'MANAGED_FILE_DRIFT')
    expect(drift?.path).toBe('.claude/agents/wrkrs-qa-engineer.md')
    expect(drift?.severity).toBe('error')
    expect(hashTree(root)).toBe(before)
  })

  it('reports seeded customization as informational', async () => {
    const { root, ports } = await install()
    appendFileSync(
      path.join(root, '.wrkrs', 'roles', 'qa-engineer.md'),
      '\n## Team notes\n\nCustom guidance.\n',
    )
    const before = hashTree(root)
    const report = await check(root, ports)
    expect(report.ok).toBe(true)
    const customized = report.diagnostics.find(
      (diagnostic) => diagnostic.code === 'SEEDED_FILE_CUSTOMIZED',
    )
    expect(customized?.path).toBe('.wrkrs/roles/qa-engineer.md')
    expect(customized?.severity).toBe('info')
    expect(hashTree(root)).toBe(before)
  })

  it('reports a removed owned file as a stable error', async () => {
    const { root, ports } = await install()
    rmSync(path.join(root, '.claude', 'agents', 'wrkrs-product-designer.md'))
    const report = await check(root, ports)
    expect(report.ok).toBe(false)
    expect(
      report.diagnostics.find((diagnostic) => diagnostic.code === 'OWNED_FILE_MISSING')?.path,
    ).toBe('.claude/agents/wrkrs-product-designer.md')
    expect(codes(report)).toContain('CLAUDE_AGENT_MISSING')
  })

  it('reports stale transactions and locks', async () => {
    const { root, ports } = await install()
    writeFileSync(
      path.join(root, '.wrkrs', '.journal.json'),
      JSON.stringify({
        schemaVersion: 1,
        transactionId: '00000000-0000-4000-8000-00000000abcd',
        command: 'init',
        planDigest: 'sha256:' + 'c'.repeat(64),
        startedAt: '2026-08-29T12:00:00.000Z',
        updatedAt: '2026-08-29T12:00:00.000Z',
        status: 'applying',
        durability: 'strict',
        operations: [
          {
            path: '.wrkrs/roles/qa-engineer.md',
            kind: 'create-file',
            status: 'retained',
            stagingPath: null,
            expectedHash: null,
            appliedHash: null,
            note: 'x',
          },
        ],
        failure: 'process killed',
      }),
    )
    writeFileSync(path.join(root, '.wrkrs', '.lock'), '{}')
    const report = await check(root, ports)
    expect(report.ok).toBe(false)
    const interrupted = report.diagnostics.find(
      (diagnostic) => diagnostic.code === 'TRANSACTION_INTERRUPTED',
    )
    expect(interrupted?.path).toBe('.wrkrs/.journal.json')
    expect(interrupted?.remediation).toContain('.wrkrs/roles/qa-engineer.md')
    expect(codes(report)).toContain('TRANSACTION_LOCK_PRESENT')
  })

  it('treats a missing local Claude executable as a warning only', async () => {
    const { root } = await install()
    const ports = createTestPorts({ environment: createTestEnvironment({ executablePaths: [] }) })
    const report = await check(root, ports)
    expect(report.ok).toBe(true)
    expect(
      report.diagnostics.find((diagnostic) => diagnostic.code === 'ENV_CLAUDE_EXECUTABLE_MISSING')
        ?.severity,
    ).toBe('warning')
  })

  it('fails on unsupported Node versions and outside Git', async () => {
    const { root } = await install()
    const old = createTestPorts({ environment: createTestEnvironment({ nodeVersion: '20.19.0' }) })
    expect(codes(await check(root, old))).toContain('ENV_NODE_VERSION_UNSUPPORTED')

    const outside = makeTempDir()
    cleanup.push(outside)
    const report = await check(outside, createTestPorts())
    expect(report.ok).toBe(false)
    expect(codes(report)).toContain('REPOSITORY_NOT_A_GIT_REPOSITORY')
    expect(report.repositoryRoot).toBeNull()
  })

  it('validates config semantics, role references, and unknown providers', async () => {
    const { root, ports } = await install()
    const configPath = path.join(root, '.wrkrs', 'config.yaml')
    appendFileSync(configPath, '')
    writeFileSync(
      configPath,
      (await import('node:fs'))
        .readFileSync(configPath, 'utf8')
        .replace(
          'connections: {}',
          'connections:\n  work-item-context:\n    provider: github\n    kind: mcp-server\n    server: tracker\n    scope: project',
        ),
    )
    writeFileSync(path.join(root, '.wrkrs', 'roles', 'qa-engineer.md'), '---\nid: not-qa\n---\n')
    const report = await check(root, ports)
    expect(codes(report)).toContain('CONNECTION_CAPABILITY_UNSUPPORTED')
    expect(codes(report)).toContain('CONFIG_ROLE_SOURCE_ID_MISMATCH')
    expect(report.ok).toBe(false)

    writeFileSync(configPath, 'schemaVersion: 7\n')
    expect(codes(await check(root, ports))).toContain('CONFIG_SCHEMA_VERSION_UNSUPPORTED')
    writeFileSync(configPath, 'schemaVersion: 1\nunknownField: true\n')
    expect(codes(await check(root, ports))).toContain('CONFIG_INVALID')
  })

  it('reports an uninstalled repository with remediation', async () => {
    const root = createFixtureRepository('clean-repository')
    cleanup.push(root)
    const report = await check(root, createTestPorts())
    expect(report.ok).toBe(false)
    expect(codes(report)).toContain('CONFIG_MISSING')
    expect(codes(report)).toContain('MANIFEST_MISSING')
    expect(
      report.diagnostics.find((diagnostic) => diagnostic.code === 'CONFIG_MISSING')?.remediation,
    ).toContain('wrkrs init')
    mkdirSync(path.join(root, '.wrkrs'))
  })

  it('produces stable, unstyled JSON', async () => {
    const { root, ports } = await install()
    const report = await check(root, ports)
    const json = checkToJson(report, '0.1.0-test')
    const text = JSON.stringify(json)
    expect(text).not.toMatch(ANSI_PATTERN)
    expect(json['ok']).toBe(true)
    expect(json['command']).toBe('check')
    const diagnostics = json['diagnostics'] as {
      code: string
      severity: string
      path: string | null
      message: string
      remediation: string | null
    }[]
    for (const diagnostic of diagnostics) {
      expect(Object.keys(diagnostic)).toEqual([
        'code',
        'severity',
        'message',
        'path',
        'remediation',
        'details',
      ])
    }
  })
})
