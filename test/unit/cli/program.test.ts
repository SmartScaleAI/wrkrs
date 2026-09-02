import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { Writable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { createNonInteractivePrompt } from '../../../src/cli/prompt.js'
import { runCli } from '../../../src/cli/program.js'
import type { PromptPort } from '../../../src/core/ports.js'
import { createNodeInputDocument } from '../../../src/platform/input-document.js'
import { ANSI_PATTERN } from '../../helpers/cli.js'
import { createTestDependencies, createTestPorts } from '../../helpers/ports.js'
import { createFixtureRepository, hashTree, removeDir } from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

function collector(): { stream: Writable; text: () => string } {
  let buffer = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += String(chunk)
      callback()
    },
  })
  return { stream, text: () => buffer }
}

async function run(argv: string[], options: { prompt?: PromptPort; colors?: boolean } = {}) {
  const stdout = collector()
  const stderr = collector()
  const deps = createTestDependencies()
  const code = await runCli(argv, {
    services: {
      wrkrsVersion: deps.wrkrsVersion,
      ports: createTestPorts(),
      prompt: options.prompt ?? createNonInteractivePrompt(),
      inputDocument: createNodeInputDocument(),
      preset: deps.preset,
      adapters: deps.adapters,
      providers: deps.providers,
    },
    streams: { stdout: stdout.stream, stderr: stderr.stream },
    colors: options.colors ?? false,
    defaultCwd: process.cwd(),
  })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

describe('cli program', () => {
  it('prints the version and help with exit 0 and usage errors with exit 2', async () => {
    expect((await run(['--version'])).code).toBe(0)
    expect((await run(['--help'])).stdout).toContain('init')
    expect((await run(['doctor'])).code).toBe(2)
    expect((await run(['init', '--nope'])).code).toBe(2)
    expect((await run(['check', '--json', '--extra'])).code).toBe(2)
  })

  it('refuses an unconfirmed apply in a non-interactive environment without writing', async () => {
    const root = createFixtureRepository('clean-repository')
    cleanup.push(root)
    const before = hashTree(root)
    const human = await run(['init', '--cwd', root])
    expect(human.code).toBe(1)
    expect(human.stderr).toContain('INIT_CONFIRMATION_REQUIRED')
    expect(hashTree(root)).toBe(before)

    const json = await run(['init', '--cwd', root, '--json'])
    expect(json.code).toBe(1)
    const parsed = JSON.parse(json.stdout) as { error: { code: string } }
    expect(parsed.error.code).toBe('INIT_CONFIRMATION_REQUIRED')
    expect(hashTree(root)).toBe(before)
  })

  it('honours interactive cancellation and confirmation', async () => {
    const root = createFixtureRepository('clean-repository')
    cleanup.push(root)
    const before = hashTree(root)
    const decline = await run(['init', '--cwd', root], {
      prompt: {
        interactive: true,
        confirm: async () => false,
        choose: async (_m, _c, defaultId) => defaultId,
      },
    })
    expect(decline.code).toBe(0)
    expect(decline.stdout).toContain('Cancelled')
    expect(hashTree(root)).toBe(before)

    let question = ''
    const accept = await run(['init', '--cwd', root], {
      prompt: {
        interactive: true,
        confirm: async (message) => {
          question = message
          return true
        },
        choose: async (_m, _c, defaultId) => defaultId,
      },
    })
    expect(accept.code).toBe(0)
    expect(question).toMatch(/Create 12 file\(s\)/)
    expect(question).toContain('sha256:')
    expect(existsSync(path.join(root, '.wrkrs', 'manifest.json'))).toBe(true)

    const rerun = await run(['init', '--cwd', root, '--yes'])
    expect(rerun.code).toBe(0)
    expect(rerun.stdout).toContain('already installed')
  })

  it('emits unstyled JSON even when colors are enabled', async () => {
    const root = createFixtureRepository('clean-repository')
    cleanup.push(root)
    const dry = await run(['init', '--dry-run', '--json', '--cwd', root], { colors: true })
    expect(dry.code).toBe(0)
    expect(dry.stdout).not.toMatch(ANSI_PATTERN)
    const parsed = JSON.parse(dry.stdout) as {
      mode: string
      result: { status: string }
      plan: { digest: string }
    }
    expect(parsed.mode).toBe('dry-run')
    expect(parsed.result.status).toBe('planned')

    const human = await run(['init', '--dry-run', '--cwd', root], { colors: true })
    expect(human.stdout).toMatch(ANSI_PATTERN)

    const check = await run(['check', '--json', '--cwd', root], { colors: true })
    expect(check.code).toBe(1)
    expect(check.stdout).not.toMatch(ANSI_PATTERN)
  })
})
