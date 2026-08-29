import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ANSI_PATTERN, runCompiledCli } from '../helpers/cli.js'
import { CLAUDE_MD_SENTINEL, SECRET_SENTINEL } from '../helpers/sentinels.js'
import {
  createFixtureRepository,
  hashTree,
  makeTempDir,
  readTree,
  removeDir,
} from '../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const GENERATED = [
  '.claude/agents/wrkrs-product-designer.md',
  '.claude/agents/wrkrs-product-manager.md',
  '.claude/agents/wrkrs-qa-engineer.md',
  '.claude/agents/wrkrs-software-engineer.md',
  '.claude/skills/wrkrs/SKILL.md',
  '.wrkrs/config.yaml',
  '.wrkrs/manifest.json',
  '.wrkrs/roles/product-designer.md',
  '.wrkrs/roles/product-manager.md',
  '.wrkrs/roles/qa-engineer.md',
  '.wrkrs/roles/software-engineer.md',
  '.wrkrs/schema.json',
]

function fixture(name: 'clean-repository' | 'existing-claude-repository'): string {
  const root = createFixtureRepository(name, { commit: true })
  cleanup.push(root)
  return root
}

describe('compiled CLI', () => {
  it('resolves the worktree root from a nested directory', async () => {
    const root = fixture('clean-repository')
    const nested = path.join(root, 'src')
    const run = await runCompiledCli(['init', '--dry-run', '--json'], { cwd: nested })
    expect(run.code).toBe(0)
    const parsed = JSON.parse(run.stdout) as { repositoryRoot: string }
    expect(parsed.repositoryRoot).toBe(root)

    const viaFlag = await runCompiledCli(['init', '--dry-run', '--json', '--cwd', nested])
    expect((JSON.parse(viaFlag.stdout) as { repositoryRoot: string }).repositoryRoot).toBe(root)
  })

  it('rejects directories outside a Git worktree without creating anything', async () => {
    const outside = makeTempDir()
    cleanup.push(outside)
    writeFileSync(path.join(outside, 'package.json'), '{}')
    const before = hashTree(outside)
    const run = await runCompiledCli(['init', '--yes'], { cwd: outside })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('REPOSITORY_NOT_A_GIT_REPOSITORY')
    expect(hashTree(outside)).toBe(before)
    const check = await runCompiledCli(['check', '--json'], { cwd: outside })
    expect(check.code).toBe(1)
    expect(JSON.parse(check.stdout)).toMatchObject({ ok: false })
  })

  it('dry run writes nothing and shows an exact diff for every generated file', async () => {
    for (const name of ['clean-repository', 'existing-claude-repository'] as const) {
      const root = fixture(name)
      const before = hashTree(root)
      const human = await runCompiledCli(['init', '--dry-run'], { cwd: root })
      expect(human.code).toBe(0)
      expect(hashTree(root)).toBe(before)
      for (const file of GENERATED) {
        expect(human.stdout).toContain(`+++ b/${file}`)
      }
      expect(human.stdout).toContain('Plan digest: sha256:')
      expect(human.stdout).not.toMatch(ANSI_PATTERN)
      expect(human.stdout + human.stderr).not.toContain(SECRET_SENTINEL)

      const json = await runCompiledCli(['init', '--dry-run', '--json'], { cwd: root })
      expect(json.code).toBe(0)
      expect(hashTree(root)).toBe(before)
      expect(json.stdout).not.toMatch(ANSI_PATTERN)
      expect(json.stdout).not.toContain(SECRET_SENTINEL)
      const parsed = JSON.parse(json.stdout) as {
        plan: {
          digest: string
          operations: {
            path: string
            outcome: string
            management: string | null
            reason: string
            expected: unknown
            proposedHash: string | null
          }[]
        }
      }
      expect(
        parsed.plan.operations
          .filter((operation) => operation.outcome === 'create')
          .map((operation) => operation.path),
      ).toEqual(GENERATED)
      for (const operation of parsed.plan.operations) {
        expect(typeof operation.reason).toBe('string')
        expect(operation.expected).toBeDefined()
      }
      const again = await runCompiledCli(['init', '--dry-run', '--json'], { cwd: root })
      expect((JSON.parse(again.stdout) as { plan: { digest: string } }).plan.digest).toBe(
        parsed.plan.digest,
      )
    }
  })

  it('installs into the clean fixture and passes check', async () => {
    const root = fixture('clean-repository')
    const run = await runCompiledCli(['init', '--yes'], { cwd: root })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Installed wrkrs')
    for (const file of GENERATED) {
      expect(existsSync(path.join(root, ...file.split('/')))).toBe(true)
    }
    for (const entry of readTree(root).filter(
      (item) => item.kind === 'file' && GENERATED.includes(item.path),
    )) {
      expect(entry.mode & 0o111).toBe(0)
    }
    expect(existsSync(path.join(root, '.wrkrs', '.journal.json'))).toBe(false)
    expect(existsSync(path.join(root, '.wrkrs', '.lock'))).toBe(false)

    const check = await runCompiledCli(['check'], { cwd: root })
    expect(check.code).toBe(0)
    expect(check.stdout).toContain('OK: 0 error(s)')
    const checkJson = await runCompiledCli(['check', '--json'], { cwd: root })
    expect(JSON.parse(checkJson.stdout)).toMatchObject({ ok: true, summary: { errors: 0 } })

    const rerun = await runCompiledCli(['init', '--yes'], { cwd: root })
    expect(rerun.code).toBe(0)
    expect(rerun.stdout).toContain('already installed')
  })

  it('installs alongside existing Claude configuration without changing a byte or mode', async () => {
    const root = fixture('existing-claude-repository')
    const before = readTree(root)
    expect(before.find((entry) => entry.path === '.claude/hooks/format.sh')!.mode & 0o111).not.toBe(
      0,
    )

    const run = await runCompiledCli(['init', '--yes', '--json'], { cwd: root })
    expect(run.code).toBe(0)
    expect(run.stdout).not.toContain(SECRET_SENTINEL)
    expect(run.stderr).not.toContain(SECRET_SENTINEL)
    const parsed = JSON.parse(run.stdout) as { result: { status: string; appliedPaths: string[] } }
    expect(parsed.result.status).toBe('applied')
    expect(parsed.result.appliedPaths).toEqual([
      ...GENERATED.filter((file) => file !== '.wrkrs/manifest.json'),
      '.wrkrs/manifest.json',
    ])

    const after = readTree(root)
    for (const entry of before) {
      const match = after.find((candidate) => candidate.path === entry.path)
      expect(match, `${entry.path} should still exist`).toBeDefined()
      expect(match).toEqual(entry)
    }
    expect(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain(CLAUDE_MD_SENTINEL)
    const manifest = readFileSync(path.join(root, '.wrkrs', 'manifest.json'), 'utf8')
    expect(manifest).not.toContain(SECRET_SENTINEL)
    expect(manifest).not.toContain(root)
    const entries = (JSON.parse(manifest) as { entries: { path: string }[] }).entries.map(
      (entry) => entry.path,
    )
    expect(entries).not.toContain('CLAUDE.md')
    expect(entries).not.toContain('.claude/settings.json')
    expect(entries).not.toContain('.mcp.json')

    const check = await runCompiledCli(['check', '--json'], { cwd: root })
    expect(check.code).toBe(0)
    expect(check.stdout).not.toContain(SECRET_SENTINEL)
  })

  it('blocks namespaced collisions and symlinks without writing', async () => {
    const root = fixture('clean-repository')
    mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
    writeFileSync(path.join(root, '.claude', 'agents', 'wrkrs-product-manager.md'), 'mine\n')
    const before = hashTree(root)
    const dry = await runCompiledCli(['init', '--dry-run', '--json'], { cwd: root })
    expect(dry.code).toBe(1)
    const parsed = JSON.parse(dry.stdout) as {
      result: { status: string }
      plan: { blockers: { code: string }[] }
    }
    expect(parsed.result.status).toBe('blocked')
    expect(parsed.plan.blockers.map((blocker) => blocker.code)).toEqual([
      'COMPONENT_CONTENT_DIFFERS',
    ])
    const apply = await runCompiledCli(['init', '--yes'], { cwd: root })
    expect(apply.code).toBe(1)
    expect(apply.stderr).toContain('Blocked')
    expect(hashTree(root)).toBe(before)

    const linked = fixture('clean-repository')
    mkdirSync(path.join(linked, '.wrkrs'))
    symlinkSync(path.join(linked, 'README.md'), path.join(linked, '.wrkrs', 'config.yaml'))
    const linkedBefore = hashTree(linked)
    const linkedRun = await runCompiledCli(['init', '--yes', '--json'], { cwd: linked })
    expect(linkedRun.code).toBe(1)
    const codes = (
      JSON.parse(linkedRun.stdout) as { plan: { blockers: { code: string }[] } }
    ).plan.blockers.map((b) => b.code)
    expect(codes).toContain('OWNERSHIP_MANIFEST_MISSING')
    expect(codes).toContain('PATH_TARGET_SYMLINK')
    expect(hashTree(linked)).toBe(linkedBefore)
  })

  it('refuses an unconfirmed non-interactive apply', async () => {
    const root = fixture('clean-repository')
    const before = hashTree(root)
    const run = await runCompiledCli(['init'], { cwd: root })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('INIT_CONFIRMATION_REQUIRED')
    expect(hashTree(root)).toBe(before)
  })

  it('detects deliberate drift after installation', async () => {
    const root = fixture('clean-repository')
    expect((await runCompiledCli(['init', '--yes'], { cwd: root })).code).toBe(0)
    appendFileSync(path.join(root, '.claude', 'agents', 'wrkrs-software-engineer.md'), '\nedited\n')
    appendFileSync(path.join(root, '.wrkrs', 'roles', 'product-manager.md'), '\nnotes\n')
    const check = await runCompiledCli(['check', '--json'], { cwd: root })
    expect(check.code).toBe(1)
    const parsed = JSON.parse(check.stdout) as {
      diagnostics: { code: string; path: string | null; severity: string }[]
    }
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'MANAGED_FILE_DRIFT',
        path: '.claude/agents/wrkrs-software-engineer.md',
        severity: 'error',
      }),
    )
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'SEEDED_FILE_CUSTOMIZED',
        path: '.wrkrs/roles/product-manager.md',
        severity: 'info',
      }),
    )
    const human = await runCompiledCli(['check'], { cwd: root })
    expect(human.stdout).toContain('MANAGED_FILE_DRIFT')
    expect(human.stdout).toContain('.claude/agents/wrkrs-software-engineer.md')
  })
})
