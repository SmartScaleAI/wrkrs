import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createNodeFileSystem } from '../../../src/platform/filesystem.js'
import { analyzeRepository } from '../../../src/repository/analyze.js'
import { frontmatterName } from '../../../src/repository/detectors/claude-code.js'
import { locateRepository } from '../../../src/repository/locate.js'
import { createTestPorts } from '../../helpers/ports.js'
import { CLAUDE_MD_SENTINEL, SECRET_SENTINEL } from '../../helpers/sentinels.js'
import { createFixtureRepository, makeTempDir, removeDir } from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

async function snapshotOf(root: string) {
  const ports = createTestPorts()
  const located = await locateRepository(root, ports)
  if (!located.ok) throw new Error(located.error.message)
  return analyzeRepository(located.value, createNodeFileSystem())
}

describe('repository analysis', () => {
  it('detects deterministic project signals in the clean fixture', async () => {
    const root = createFixtureRepository('clean-repository')
    cleanup.push(root)
    const first = await snapshotOf(root)
    const second = await snapshotOf(root)
    expect(first.projectSignals).toEqual(second.projectSignals)
    expect(
      first.projectSignals.map((signal) => `${signal.id}:${signal.path}:${signal.detail}`),
    ).toEqual([
      'node.package:package.json:package manifest',
      'typescript.dependency:package.json:devDependencies.typescript',
      'typescript.tsconfig:tsconfig.json:TypeScript config',
      'web.react:package.json:dependencies.react',
    ])
    expect(first.claude.claudeMd).toBeNull()
    expect(first.claude.agents).toEqual([])
    expect(first.wrkrs.directoryKind).toBeNull()
    expect(first.findings.some((finding) => finding.code === 'PROJECT_SIGNAL')).toBe(true)
  })

  it('detects every existing Claude component in the existing-claude fixture without leaking values', async () => {
    const root = createFixtureRepository('existing-claude-repository')
    cleanup.push(root)
    const snapshot = await snapshotOf(root)
    expect(snapshot.claude.claudeMd).toBe('CLAUDE.md')
    expect(snapshot.claude.settings?.valid).toBe(true)
    expect(snapshot.claude.settings?.hookEvents).toEqual(['PostToolUse'])
    expect(snapshot.claude.settings?.hookCount).toBe(1)
    expect(snapshot.claude.settings?.permissionRuleCounts).toEqual({ allow: 2, deny: 1, ask: 1 })
    expect(snapshot.claude.settingsLocal?.path).toBe('.claude/settings.local.json')
    expect(snapshot.claude.agents).toEqual([
      { path: '.claude/agents/custom-reviewer.md', name: 'custom-reviewer' },
    ])
    expect(snapshot.claude.skills).toEqual([
      { path: '.claude/skills/custom-skill/SKILL.md', name: 'custom-skill' },
    ])
    expect(snapshot.claude.commands.map((command) => command.path)).toEqual([
      '.claude/commands/custom-command.md',
    ])
    expect(snapshot.claude.hooks.map((hook) => hook.path)).toEqual(['.claude/hooks/format.sh'])
    expect(snapshot.claude.mcp?.servers).toEqual([
      { name: 'fake-remote', transport: 'http' },
      { name: 'fake-tracker', transport: 'stdio' },
    ])
    expect(snapshot.projectSignals.map((signal) => signal.id)).toContain('backend.node')

    const serialized = JSON.stringify({ ...snapshot, files: [...snapshot.files.entries()] })
    expect(serialized).not.toContain(SECRET_SENTINEL)
    expect(serialized).not.toContain(CLAUDE_MD_SENTINEL)
    expect(serialized).not.toContain('example.invalid')
  })

  it('reports invalid Claude JSON as warnings and unknown repositories without failing', async () => {
    const root = makeTempDir()
    cleanup.push(root)
    mkdirSync(path.join(root, '.claude'))
    writeFileSync(path.join(root, '.claude', 'settings.json'), '{ not json')
    writeFileSync(path.join(root, '.mcp.json'), 'nope')
    writeFileSync(path.join(root, 'package.json'), '{{')
    const { gitInit } = await import('../../helpers/temp.js')
    gitInit(root)
    const snapshot = await snapshotOf(root)
    const codes = snapshot.findings.map((finding) => finding.code)
    expect(codes).toContain('CLAUDE_SETTINGS_INVALID')
    expect(codes).toContain('CLAUDE_MCP_INVALID')
    expect(codes).toContain('PROJECT_PACKAGE_JSON_INVALID')
    expect(codes).toContain('PROJECT_NO_SIGNALS')
  })

  it('indexes symlinks without following them and records existing wrkrs state', async () => {
    const root = createFixtureRepository('clean-repository')
    cleanup.push(root)
    mkdirSync(path.join(root, '.claude'))
    symlinkSync(path.join(root, 'src'), path.join(root, '.claude', 'agents'))
    mkdirSync(path.join(root, '.wrkrs'))
    writeFileSync(path.join(root, '.wrkrs', '.lock'), '{}')
    const snapshot = await snapshotOf(root)
    expect(snapshot.files.get('.claude/agents')?.kind).toBe('symlink')
    expect(snapshot.files.has('.claude/agents/index.ts')).toBe(false)
    expect(snapshot.wrkrs.directoryKind).toBe('directory')
    expect(snapshot.wrkrs.manifest).toBeNull()
    expect(snapshot.wrkrs.lockPresent).toBe(true)
    expect(snapshot.findings.map((finding) => finding.code)).toContain(
      'WRKRS_DIRECTORY_WITHOUT_MANIFEST',
    )
  })

  it('rejects directories outside a Git worktree and bare repositories', async () => {
    const ports = createTestPorts()
    const outside = makeTempDir()
    cleanup.push(outside)
    const result = await locateRepository(outside, ports)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('GIT_NOT_A_REPOSITORY')

    const missing = await locateRepository(path.join(outside, 'missing'), ports)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('CWD_NOT_FOUND')

    const { execFileSync } = await import('node:child_process')
    const bare = makeTempDir()
    cleanup.push(bare)
    execFileSync('git', ['init', '-q', '--bare', bare])
    const bareResult = await locateRepository(bare, ports)
    expect(bareResult.ok).toBe(false)
    if (!bareResult.ok) expect(bareResult.error.code).toBe('GIT_BARE_REPOSITORY')
  })

  it('resolves the worktree root from a nested directory', async () => {
    const root = createFixtureRepository('clean-repository')
    cleanup.push(root)
    const nested = path.join(root, 'src')
    const located = await locateRepository(nested, createTestPorts())
    expect(located.ok).toBe(true)
    if (located.ok) {
      expect(located.value.root).toBe(root)
      expect(located.value.cwd).toBe(nested)
      expect(located.value.dirty).toBe(true)
    }
  })

  it('reads only the name from frontmatter', () => {
    expect(frontmatterName('---\nname: "quoted"\ndescription: secret\n---\nbody')).toBe('quoted')
    expect(frontmatterName('no frontmatter')).toBeNull()
    expect(frontmatterName('---\ndescription: only\n---\n')).toBeNull()
  })
})
