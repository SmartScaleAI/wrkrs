import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseFrontmatter } from '../../src/core/frontmatter.js'
import { runCompiledCli } from '../helpers/cli.js'
import { createFixtureRepository, removeDir } from '../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const AGENT_NAMES = [
  'wrkrs-product-manager',
  'wrkrs-product-designer',
  'wrkrs-software-engineer',
  'wrkrs-qa-engineer',
] as const

describe('installed team contract', () => {
  it('153: init --yes installs a waiting /wrkrs skill, four named agents, and a passing check', async () => {
    const root = createFixtureRepository('clean-repository', { commit: true })
    cleanup.push(root)
    const init = await runCompiledCli(['init', '--yes', '--json'], { cwd: root })
    expect(init.code).toBe(0)

    const skill = parseFrontmatter(
      readFileSync(path.join(root, '.claude', 'skills', 'wrkrs', 'SKILL.md'), 'utf8'),
    )
    expect(skill?.fields.get('name')).toBe('wrkrs')
    expect(skill?.fields.get('context')).toBe('fork')
    expect(skill?.fields.get('background')).toBe('false')
    expect(skill?.fields.get('agent')).toBe('wrkrs-product-manager')
    expect(skill?.fields.get('disable-model-invocation')).toBe('true')

    for (const name of AGENT_NAMES) {
      const file = path.join(root, '.claude', 'agents', `${name}.md`)
      expect(existsSync(file)).toBe(true)
      expect(parseFrontmatter(readFileSync(file, 'utf8'))?.fields.get('name')).toBe(name)
    }

    const check = await runCompiledCli(['check', '--json'], { cwd: root })
    expect(check.code).toBe(0)
    const parsed = JSON.parse(check.stdout) as {
      ok: boolean
      diagnostics: { code: string }[]
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain('CLAUDE_ADAPTER_OK')

    // Optional Claude Code presence: never invoke a session, never fail CI if absent.
    try {
      const version = execFileSync('claude', ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      })
      expect(version.trim().length).toBeGreaterThan(0)
    } catch {
      // Claude Code is not required for this contract.
    }
  })
})
