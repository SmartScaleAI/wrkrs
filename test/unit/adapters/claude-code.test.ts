import { mkdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createClaudeCodeAdapter } from '../../../src/adapters/claude-code/adapter.js'
import { isNamespacedPath } from '../../../src/adapters/claude-code/layout.js'
import { parseFrontmatter } from '../../../src/core/frontmatter.js'
import { recommendRoster } from '../../../src/core/roster.js'
import { renderTemplate } from '../../../src/core/template.js'
import { buildConfig } from '../../../src/init/init.js'
import { createNodeFileSystem } from '../../../src/platform/filesystem.js'
import {
  compilePortableRoles,
  productEngineeringPreset,
} from '../../../src/presets/product-engineering/index.js'
import { makeTempDir, removeDir } from '../../helpers/temp.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) removeDir(directory)
})

const roster = recommendRoster(productEngineeringPreset, [
  { id: 'web.react', path: 'package.json', detail: 'dependencies.react' },
])
const config = buildConfig(roster)
const roles = compilePortableRoles(roster)
const adapter = createClaudeCodeAdapter()

describe('Claude Code adapter compile', () => {
  it('emits four namespaced agents and the explicit skill with the approved frontmatter', () => {
    const components = adapter.compile({ roster, config, roles })
    expect(components.map((component) => component.path)).toEqual([
      '.claude/agents/wrkrs-product-manager.md',
      '.claude/agents/wrkrs-product-designer.md',
      '.claude/agents/wrkrs-software-engineer.md',
      '.claude/agents/wrkrs-qa-engineer.md',
      '.claude/skills/wrkrs/SKILL.md',
    ])
    for (const component of components) {
      expect(component.management).toBe('managed')
      expect(component.content.endsWith('\n')).toBe(true)
      expect(component.content).not.toMatch(/\{\{/)
      const frontmatter = parseFrontmatter(component.content)
      expect(frontmatter).not.toBeNull()
      expect(frontmatter?.fields.get('description')).toBeTruthy()
      // No permissions, tools, hooks, or model invocation settings are granted.
      expect(frontmatter?.fields.has('tools')).toBe(false)
      expect(frontmatter?.fields.has('permissionMode')).toBe(false)
      expect(frontmatter?.fields.has('hooks')).toBe(false)
    }
    const engineer = components.find((component) =>
      component.path.endsWith('wrkrs-software-engineer.md'),
    )
    expect(parseFrontmatter(engineer!.content)?.fields.get('name')).toBe('wrkrs-software-engineer')
    expect(parseFrontmatter(engineer!.content)?.fields.get('description')).toContain('web-frontend')
    expect(engineer!.content).toContain('## Specializations')
    expect(engineer!.content).toContain('`web-frontend`')

    const skill = components.find(
      (component) => component.path === '.claude/skills/wrkrs/SKILL.md',
    )!
    const fields = parseFrontmatter(skill.content)!.fields
    expect(fields.get('name')).toBe('wrkrs')
    expect(fields.get('context')).toBe('fork')
    expect(fields.get('agent')).toBe('wrkrs-product-manager')
    expect(fields.get('disable-model-invocation')).toBe('true')
    expect(fields.get('argument-hint')).toBe('<requested outcome>')
    expect(skill.content).toContain('$ARGUMENTS')
  })

  it('renders role templates with frontmatter ids and no unresolved placeholders', () => {
    for (const role of roles) {
      expect(parseFrontmatter(role.content)?.fields.get('id')).toBe(role.id)
      expect(role.content).not.toMatch(/\{\{/)
    }
    const engineer = roles.find((role) => role.id === 'software-engineer')!
    expect(engineer.content).toContain('**Web frontend (React, Next.js)** (`web-frontend`)')
    const noSignals = compilePortableRoles(recommendRoster(productEngineeringPreset, []))
    expect(noSignals.find((role) => role.id === 'software-engineer')!.content).toContain(
      'No repository-specific specialization was detected',
    )
  })

  it('classifies namespaced paths', () => {
    expect(isNamespacedPath('.claude/agents/wrkrs-qa-engineer.md')).toBe(true)
    expect(isNamespacedPath('.claude/skills/wrkrs/SKILL.md')).toBe(true)
    expect(isNamespacedPath('.claude/agents/custom-reviewer.md')).toBe(false)
    expect(isNamespacedPath('.claude/skills/custom-skill/SKILL.md')).toBe(false)
  })

  it('strict template rendering rejects unknown and unused variables', () => {
    expect(renderTemplate('a {{x}}', { x: '1' })).toBe('a 1')
    expect(() => renderTemplate('a {{x}}', {})).toThrow(/no value/)
    expect(() => renderTemplate('a', { x: '1' })).toThrow(/not used/)
  })
})

describe('Claude Code adapter validate', () => {
  it('accepts the compiled projections and reports mismatches', async () => {
    const root = makeTempDir()
    cleanup.push(root)
    const fs = createNodeFileSystem()
    for (const component of adapter.compile({ roster, config, roles })) {
      const target = path.join(root, ...component.path.split('/'))
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, component.content)
    }
    const valid = await adapter.validate({ root, fs, config, manifest: null })
    expect(valid.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(valid.map((diagnostic) => diagnostic.code)).toContain('CLAUDE_ADAPTER_OK')

    writeFileSync(
      path.join(root, '.claude', 'agents', 'wrkrs-qa-engineer.md'),
      '---\nname: wrong-name\ndescription: x\n---\nbody\n',
    )
    writeFileSync(
      path.join(root, '.claude', 'skills', 'wrkrs', 'SKILL.md'),
      '---\nname: wrkrs\ncontext: inline\n---\n',
    )
    writeFileSync(
      path.join(root, '.claude', 'agents', 'wrkrs-extra.md'),
      '---\nname: wrkrs-extra\n---\n',
    )
    const invalid = await adapter.validate({ root, fs, config, manifest: null })
    const codes = invalid.map((diagnostic) => diagnostic.code)
    expect(codes).toContain('CLAUDE_AGENT_NAME_MISMATCH')
    expect(codes).toContain('CLAUDE_SKILL_FRONTMATTER_INVALID')
    expect(codes).toContain('CLAUDE_COMPONENT_UNEXPECTED')
    expect(codes).not.toContain('CLAUDE_ADAPTER_OK')
  })
})
