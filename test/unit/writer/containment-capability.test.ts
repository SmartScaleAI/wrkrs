import { Writable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { runCheck } from '../../../src/check/check.js'
import { renderCheck, createStyler } from '../../../src/cli/output/human-reporter.js'
import { checkToJson } from '../../../src/cli/output/json-reporter.js'
import { runCli } from '../../../src/cli/program.js'
import { createNonInteractivePrompt } from '../../../src/cli/prompt.js'
import { createNodeInputDocument } from '../../../src/platform/input-document.js'
import { applyPreparedInit, prepareInit } from '../../../src/init/init.js'
import {
  createNodeFileSystem,
  detectContainmentCapability,
} from '../../../src/platform/filesystem.js'
import { ANSI_PATTERN } from '../../helpers/cli.js'
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

const REASON = 'simulated Windows: the working directory is tracked by path'

function unsupportedFileSystem() {
  let bindings = 0
  const fs = interceptFileSystem(
    createNodeFileSystem({ containment: { supported: false, reason: REASON } }),
    {
      withinDirectory: async (_context, next) => {
        bindings += 1
        return next()
      },
    },
  )
  return { fs, bindings: () => bindings }
}

function collector() {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk)
      callback()
    },
  })
  return { stream, text: () => text }
}

async function cli(args: string[], fs = unsupportedFileSystem().fs) {
  const stdout = collector()
  const stderr = collector()
  const deps = createTestDependencies()
  const code = await runCli(args, {
    services: {
      wrkrsVersion: deps.wrkrsVersion,
      ports: createTestPorts({ fs }),
      prompt: createNonInteractivePrompt(),
      inputDocument: createNodeInputDocument(),
      preset: deps.preset,
      adapters: deps.adapters,
      providers: deps.providers,
    },
    streams: { stdout: stdout.stream, stderr: stderr.stream },
    colors: true,
    defaultCwd: process.cwd(),
  })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

describe('containment capability gate', () => {
  it('blocks init --dry-run before any repository-content access', async () => {
    const root = createFixtureRepository('existing-claude-repository', { commit: true })
    cleanup.push(root)
    const before = hashTree(root)
    const { fs, bindings } = unsupportedFileSystem()
    const human = await cli(['init', '--dry-run', '--cwd', root], fs)
    expect(human.code).toBe(1)
    expect(human.stderr).toContain('ENVIRONMENT_CONTAINMENT_UNSUPPORTED')
    expect(human.stderr).toContain(REASON)
    expect(human.stdout).toBe('')
    const json = await cli(['init', '--dry-run', '--json', '--cwd', root], fs)
    expect(json.code).toBe(1)
    const parsed = JSON.parse(json.stdout) as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe('ENVIRONMENT_CONTAINMENT_UNSUPPORTED')
    expect(parsed.error.message).toContain(REASON)
    expect(json.stdout).not.toMatch(ANSI_PATTERN)
    expect(bindings()).toBe(0)
    expect(hashTree(root)).toBe(before)
  })

  it('blocks applying, both through the CLI and directly on a prepared plan', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const before = hashTree(root)
    const { fs, bindings } = unsupportedFileSystem()
    const applied = await cli(['init', '--yes', '--cwd', root], fs)
    expect(applied.code).toBe(1)
    expect(applied.stderr).toContain('ENVIRONMENT_CONTAINMENT_UNSUPPORTED')
    expect(bindings()).toBe(0)
    expect(hashTree(root)).toBe(before)

    const supported = createTestPorts()
    const prepared = await prepareInit(root, createTestDependencies(), supported)
    if (!prepared.ok) throw prepared.error
    const result = await applyPreparedInit(
      prepared.value,
      createTestDependencies(),
      createTestPorts({ fs }),
    )
    expect(result.status).toBe('aborted')
    if (result.status === 'aborted') {
      expect(result.conflicts.map((conflict) => conflict.code)).toEqual([
        'ENVIRONMENT_CONTAINMENT_UNSUPPORTED',
      ])
    }
    expect(hashTree(root)).toBe(before)
  })

  it('makes check report the stable error after environment and worktree detection, without content reads', async () => {
    const root = createFixtureRepository('existing-claude-repository', { commit: true })
    cleanup.push(root)
    const { fs, bindings } = unsupportedFileSystem()
    const deps = createTestDependencies()
    const report = await runCheck(
      {
        cwd: root,
        wrkrsVersion: deps.wrkrsVersion,
        adapters: deps.adapters,
        providers: deps.providers,
      },
      createTestPorts({ fs }),
    )
    const codes = report.diagnostics.map((diagnostic) => diagnostic.code)
    expect(report.ok).toBe(false)
    expect(codes).toContain('ENVIRONMENT_CONTAINMENT_UNSUPPORTED')
    expect(codes).toContain('REPOSITORY_OK')
    expect(codes).toContain('ENV_NODE_VERSION_OK')
    expect(
      codes.some(
        (code) =>
          code.startsWith('CONFIG_') ||
          code.startsWith('MANIFEST_') ||
          code.startsWith('CLAUDE_') ||
          code.startsWith('OWNED_'),
      ),
    ).toBe(false)
    expect(bindings()).toBe(0)
    const human = renderCheck(report, createStyler(false), deps.wrkrsVersion)
    const json = JSON.stringify(checkToJson(report, deps.wrkrsVersion))
    for (const output of [human, json]) {
      expect(output).toContain('ENVIRONMENT_CONTAINMENT_UNSUPPORTED')
      expect(output).toContain(REASON)
      expect(output).not.toMatch(/E[A-Z]{3,}:/)
      expect(output).not.toMatch(ANSI_PATTERN)
    }
    const viaCli = await cli(['check', '--json', '--cwd', root], fs)
    expect(viaCli.code).toBe(1)
    expect((JSON.parse(viaCli.stdout) as { ok: boolean }).ok).toBe(false)
  })

  it('keeps --help and --version working when containment is unsupported', async () => {
    const help = await cli(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('init')
    const version = await cli(['--version'])
    expect(version.code).toBe(0)
    expect(version.stdout.trim()).toBe(createTestDependencies().wrkrsVersion)
  })

  it('detects support on this platform and runs the normal flows through it', async () => {
    const capability = detectContainmentCapability()
    expect(capability.supported).toBe(process.platform !== 'win32')
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const ports = createTestPorts()
    expect(ports.fs.containment.supported).toBe(true)
    const prepared = await prepareInit(root, createTestDependencies(), ports)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.value.plan.blockers).toEqual([])
    const result = await applyPreparedInit(prepared.value, createTestDependencies(), ports)
    expect(result.status).toBe('applied')
  })
})
