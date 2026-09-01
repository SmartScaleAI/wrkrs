import { describe, expect, it } from 'vitest'

import { renderCreateDiff, renderRemoveDiff, renderReplaceDiff } from '../../../src/planner/diff.js'

describe('diff rendering', () => {
  it('renders a create as a complete addition against /dev/null', () => {
    expect(renderCreateDiff('a.md', 'one\ntwo\n')).toBe(
      ['--- /dev/null', '+++ b/a.md', '@@ -0,0 +1,2 @@', '+one', '+two', ''].join('\n'),
    )
  })

  it('renders a removal as a complete deletion', () => {
    expect(renderRemoveDiff('a.md', 'one\ntwo\n')).toBe(
      ['--- a/a.md', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two', ''].join('\n'),
    )
  })

  it('marks a missing final newline on both sides', () => {
    expect(renderCreateDiff('a.md', 'one')).toContain('\\ No newline at end of file')
    expect(renderRemoveDiff('a.md', 'one')).toContain('\\ No newline at end of file')
  })

  it('renders an empty file without a body', () => {
    expect(renderCreateDiff('a.md', '')).toBe(
      ['--- /dev/null', '+++ b/a.md', '@@ -0,0 +1,0 @@', ''].join('\n'),
    )
  })

  it('shows only the changed region of a replacement, with context', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n') + '\n'
    const after = ['a', 'b', 'c', 'd', 'CHANGED', 'f', 'g', 'h', 'i'].join('\n') + '\n'
    const diff = renderReplaceDiff('a.md', before, after)
    expect(diff).toContain('--- a/a.md')
    expect(diff).toContain('+++ b/a.md')
    expect(diff).toContain('-e')
    expect(diff).toContain('+CHANGED')
    // Unchanged lines beyond the context window are not printed.
    expect(diff).not.toContain(' a\n')
    expect(diff).toContain('@@ -2,7 +2,7 @@')
  })

  it('produces no hunk when the two sides are identical', () => {
    const text = 'one\ntwo\n'
    expect(renderReplaceDiff('a.md', text, text)).toBe('--- a/a.md\n+++ b/a.md\n')
  })

  it('renders separate hunks for distant changes', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`)
    const before = lines.join('\n') + '\n'
    const changed = [...lines]
    changed[2] = 'first change'
    changed[35] = 'second change'
    const diff = renderReplaceDiff('a.md', before, changed.join('\n') + '\n')
    expect(diff.match(/^@@ /gm)?.length).toBe(2)
    expect(diff).toContain('+first change')
    expect(diff).toContain('+second change')
  })

  it('falls back to a complete replacement for a file beyond the context limit', () => {
    const before = Array.from({ length: 4100 }, (_, index) => `a${index}`).join('\n') + '\n'
    const after = Array.from({ length: 4100 }, (_, index) => `b${index}`).join('\n') + '\n'
    const diff = renderReplaceDiff('big.md', before, after)
    expect(diff.match(/^@@ /gm)?.length).toBe(1)
    expect(diff).toContain('@@ -1,4100 +1,4100 @@')
    expect(diff).toContain('-a0')
    expect(diff).toContain('+b0')
  })

  it('handles pure insertions and pure deletions', () => {
    const inserted = renderReplaceDiff('a.md', 'one\n', 'one\ntwo\n')
    expect(inserted).toContain('+two')
    expect(inserted).not.toContain('-one')

    const deleted = renderReplaceDiff('a.md', 'one\ntwo\n', 'one\n')
    expect(deleted).toContain('-two')
    expect(deleted).not.toContain('+one')
  })
})
