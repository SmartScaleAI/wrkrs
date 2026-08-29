import { describe, expect, it } from 'vitest'

import {
  ancestorDirectories,
  caseFoldKey,
  isWithinRoot,
  normalizeRelativePath,
  parentDirectory,
  baseName,
} from '../../../src/platform/paths.js'

function expectIssue(input: string, code: string): void {
  const result = normalizeRelativePath(input)
  expect(result.ok, `expected ${JSON.stringify(input)} to be rejected`).toBe(false)
  if (!result.ok) expect(result.error.code).toBe(code)
}

describe('normalizeRelativePath', () => {
  it('accepts and normalizes POSIX and Windows separators', () => {
    expect(normalizeRelativePath('.wrkrs/config.yaml')).toEqual({
      ok: true,
      value: '.wrkrs/config.yaml',
    })
    expect(normalizeRelativePath('.claude\\agents\\wrkrs-qa.md')).toEqual({
      ok: true,
      value: '.claude/agents/wrkrs-qa.md',
    })
    expect(normalizeRelativePath('./a//b/./c.md')).toEqual({ ok: true, value: 'a/b/c.md' })
  })

  it('rejects absolute, empty, traversal, NUL, reserved, and invalid paths', () => {
    expectIssue('/etc/passwd', 'PATH_ABSOLUTE')
    expectIssue('C:\\Windows\\system32', 'PATH_ABSOLUTE')
    expectIssue('\\\\server\\share', 'PATH_ABSOLUTE')
    expectIssue('', 'PATH_EMPTY')
    expectIssue('.', 'PATH_EMPTY')
    expectIssue('../outside.md', 'PATH_TRAVERSAL')
    expectIssue('.claude/../../x', 'PATH_TRAVERSAL')
    expectIssue('a/b' + String.fromCharCode(0) + 'c', 'PATH_NUL')
    expectIssue('.wrkrs/CON', 'PATH_RESERVED_NAME')
    expectIssue('.wrkrs/nul.md', 'PATH_RESERVED_NAME')
    expectIssue('.wrkrs/com1', 'PATH_RESERVED_NAME')
    expectIssue('.wrkrs/a:b.md', 'PATH_INVALID_CHARACTER')
    expectIssue('.wrkrs/a?b.md', 'PATH_INVALID_CHARACTER')
    expectIssue('.wrkrs/trailing.', 'PATH_INVALID_SEGMENT')
    expectIssue('.wrkrs/trailing ', 'PATH_INVALID_SEGMENT')
  })
})

describe('path helpers', () => {
  it('lists ancestors shallowest first', () => {
    expect(ancestorDirectories('.claude/skills/wrkrs/SKILL.md')).toEqual([
      '.claude',
      '.claude/skills',
      '.claude/skills/wrkrs',
    ])
    expect(ancestorDirectories('CLAUDE.md')).toEqual([])
    expect(parentDirectory('a/b')).toBe('a')
    expect(parentDirectory('a')).toBeNull()
    expect(baseName('a/b.md')).toBe('b.md')
  })

  it('case-folds for collision detection with unicode normalization', () => {
    expect(caseFoldKey('.claude/agents/WRKRS-QA.md')).toBe('.claude/agents/wrkrs-qa.md')
    expect(caseFoldKey('caf\u00e9')).toBe(caseFoldKey('cafe\u0301'))
  })

  it('checks containment using a separator boundary', () => {
    expect(isWithinRoot('/repo', '/repo/a')).toBe(true)
    expect(isWithinRoot('/repo', '/repo')).toBe(true)
    expect(isWithinRoot('/repo', '/repository/a')).toBe(false)
    expect(isWithinRoot('/repo', '/other')).toBe(false)
  })
})
