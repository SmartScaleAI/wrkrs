import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runCheck } from '../../../src/check/check.js'
import { parseAnswersBytes } from '../../../src/init/answers.js'
import { applyPreparedInit, prepareInit } from '../../../src/init/init.js'
import {
  ANSWERS_DOCUMENT_MAX_BYTES,
  createNodeInputDocument,
} from '../../../src/platform/input-document.js'
import {
  createTestDependencies,
  createTestEnvironment,
  createTestPorts,
} from '../../helpers/ports.js'
import { createFixtureRepository, removeDir } from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

async function installEmpty() {
  const root = createFixtureRepository('clean-repository', { commit: true })
  cleanup.push(root)
  const deps = createTestDependencies()
  const ports = createTestPorts()
  const prepared = await prepareInit(root, deps, ports)
  if (!prepared.ok) throw prepared.error
  const applied = await applyPreparedInit(prepared.value, deps, ports)
  expect(applied.status).toBe('applied')
  return { root, deps, ports }
}

describe('connection check and answers input', () => {
  it('94: user-scoped servers are declared-unverified; a missing PATH executable is a warning', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const deps = createTestDependencies()
    const ports = createTestPorts()
    const prepared = await prepareInit(root, deps, ports, {
      connections: {
        'work-item-context': {
          provider: 'linear',
          kind: 'mcp-server',
          server: 'linear',
          scope: 'user',
        },
        'source-control-context': { provider: 'github', kind: 'cli', executable: 'gh' },
      },
    })
    if (!prepared.ok) throw prepared.error
    expect((await applyPreparedInit(prepared.value, deps, ports)).status).toBe('applied')
    const report = await runCheck(
      {
        cwd: root,
        wrkrsVersion: deps.wrkrsVersion,
        adapters: deps.adapters,
        providers: deps.providers,
      },
      createTestPorts({ environment: createTestEnvironment({ executablePaths: [] }) }),
    )
    const unverified = report.diagnostics.find((item) => item.code === 'CONNECTION_UNVERIFIED')
    expect(unverified?.severity).toBe('warning')
    expect(unverified?.path).toContain('work-item-context')
    const missingCli = report.diagnostics.find((item) => item.code === 'CONNECTION_CLI_UNAVAILABLE')
    expect(missingCli?.severity).toBe('warning')
    expect(missingCli?.path).toContain('source-control-context')
  })

  it('verifies a configured CLI executable other than gh when it is on PATH', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const bin = mkdtempSync(path.join(tmpdir(), 'wrkrs-cli-bin-'))
    cleanup.push(bin)
    writeFileSync(path.join(bin, 'hub'), '')
    const deps = createTestDependencies()
    const ports = createTestPorts({
      environment: createTestEnvironment({ executablePaths: [bin], pathExtensions: [''] }),
    })
    const prepared = await prepareInit(root, deps, ports, {
      connections: {
        'source-control-context': { provider: 'github', kind: 'cli', executable: 'hub' },
      },
    })
    if (!prepared.ok) throw prepared.error
    expect((await applyPreparedInit(prepared.value, deps, ports)).status).toBe('applied')
    const report = await runCheck(
      {
        cwd: root,
        wrkrsVersion: deps.wrkrsVersion,
        adapters: deps.adapters,
        providers: deps.providers,
      },
      ports,
    )
    const ok = report.diagnostics.find(
      (item) =>
        item.code === 'CONNECTION_OK' &&
        typeof item.path === 'string' &&
        item.path.includes('source-control-context'),
    )
    expect(ok?.severity).toBe('info')
    expect(
      report.diagnostics.find((item) => item.code === 'CONNECTION_CLI_UNAVAILABLE'),
    ).toBeUndefined()
  })

  it('95: missing, unknown-provider, and unsupported-capability bindings name the exact path', async () => {
    const { root, deps, ports } = await installEmpty()
    const configPath = path.join(root, '.wrkrs', 'config.yaml')
    const original = readFileSync(configPath, 'utf8')
    writeFileSync(
      configPath,
      original.replace(
        'connections: {}',
        [
          'connections:',
          '  source-control-context:',
          '    provider: github',
          '    kind: mcp-server',
          '    server: missing-github',
          '    scope: project',
          '  work-item-context:',
          '    provider: github',
          '    kind: mcp-server',
          '    server: github',
          '    scope: project',
        ].join('\n'),
      ),
    )
    const report = await runCheck(
      {
        cwd: root,
        wrkrsVersion: deps.wrkrsVersion,
        adapters: deps.adapters,
        providers: deps.providers,
      },
      ports,
    )
    const missing = report.diagnostics.find((item) => item.code === 'CONNECTION_SERVER_MISSING')
    expect(missing?.severity).toBe('error')
    expect(missing?.path).toContain('source-control-context')
    const unsupported = report.diagnostics.find(
      (item) => item.code === 'CONNECTION_CAPABILITY_UNSUPPORTED',
    )
    expect(unsupported?.path).toContain('work-item-context')

    writeFileSync(
      configPath,
      original.replace(
        'connections: {}',
        [
          'connections:',
          '  work-item-context:',
          '    provider: jira',
          '    kind: mcp-server',
          '    server: tracker',
          '    scope: project',
        ].join('\n'),
      ),
    )
    const unknown = await runCheck(
      {
        cwd: root,
        wrkrsVersion: deps.wrkrsVersion,
        adapters: deps.adapters,
        providers: deps.providers,
      },
      ports,
    )
    const provider = unknown.diagnostics.find((item) => item.code === 'CONNECTION_PROVIDER_UNKNOWN')
    expect(provider).toBeDefined()
    expect(JSON.stringify(unknown)).toContain('work-item-context')
    expect(JSON.stringify(unknown)).not.toContain('\u001b')
  })

  it('152: a dedicated provider bound to an existing unmatched MCP server is a mismatch, not OK', async () => {
    const root = createFixtureRepository('existing-claude-repository', { commit: true })
    cleanup.push(root)
    const deps = createTestDependencies()
    const ports = createTestPorts()
    const prepared = await prepareInit(root, deps, ports)
    if (!prepared.ok) throw prepared.error
    expect((await applyPreparedInit(prepared.value, deps, ports)).status).toBe('applied')
    const configPath = path.join(root, '.wrkrs', 'config.yaml')
    const original = readFileSync(configPath, 'utf8')
    writeFileSync(
      configPath,
      original.replace(
        'connections: {}',
        [
          'connections:',
          '  source-control-context:',
          '    provider: github',
          '    kind: mcp-server',
          '    server: fake-tracker',
          '    scope: project',
        ].join('\n'),
      ),
    )
    const report = await runCheck(
      {
        cwd: root,
        wrkrsVersion: deps.wrkrsVersion,
        adapters: deps.adapters,
        providers: deps.providers,
      },
      ports,
    )
    expect(report.ok).toBe(false)
    const mismatch = report.diagnostics.find(
      (item) => item.code === 'CONNECTION_SERVER_PROVIDER_MISMATCH',
    )
    expect(mismatch?.severity).toBe('error')
    expect(mismatch?.path).toContain('source-control-context')
    expect(
      report.diagnostics.find((item) => item.code === 'CONNECTION_SERVER_MISSING'),
    ).toBeUndefined()
    expect(
      report.diagnostics.find(
        (item) =>
          item.code === 'CONNECTION_OK' &&
          typeof item.path === 'string' &&
          item.path.includes('source-control-context'),
      ),
    ).toBeUndefined()
    expect(JSON.stringify(report.diagnostics)).not.toContain('fake-tracker')
  })

  it('138: --answers rejects a final symlink, a non-regular file, and an oversize file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wrkrs-answers-port-'))
    cleanup.push(dir)
    const port = createNodeInputDocument()
    const target = path.join(dir, 'answers.json')
    writeFileSync(target, '{"schemaVersion":1}\n')
    const link = path.join(dir, 'answers.link')
    symlinkSync(target, link)
    const linked = await port.read(link, { cwd: dir, maxBytes: ANSWERS_DOCUMENT_MAX_BYTES })
    expect(linked.ok).toBe(false)
    if (!linked.ok) expect(linked.error.code).toBe('ANSWERS_SYMLINK')

    const nested = path.join(dir, 'subdir')
    mkdirSync(nested)
    const asDir = await port.read(nested, { cwd: dir, maxBytes: ANSWERS_DOCUMENT_MAX_BYTES })
    expect(asDir.ok).toBe(false)
    if (!asDir.ok) expect(asDir.error.code).toBe('ANSWERS_NOT_A_FILE')

    const huge = path.join(dir, 'huge.json')
    writeFileSync(huge, 'x'.repeat(ANSWERS_DOCUMENT_MAX_BYTES + 1))
    const oversize = await port.read(huge, { cwd: dir, maxBytes: ANSWERS_DOCUMENT_MAX_BYTES })
    expect(oversize.ok).toBe(false)
    if (!oversize.ok) expect(oversize.error.code).toBe('ANSWERS_TOO_LARGE')

    const utf8 = parseAnswersBytes(new Uint8Array([0xff, 0xfe]))
    expect(utf8.ok).toBe(false)
    if (!utf8.ok) expect(utf8.error.code).toBe('ANSWERS_NOT_UTF8')
  })
})
