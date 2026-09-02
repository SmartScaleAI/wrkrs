/**
 * Unified diff rendering. Creates and removals are complete additions or
 * deletions; a replacement is a real context diff so the reviewer sees only
 * what changed.
 */

/** Splits content into lines, dropping the final empty element of a trailing newline. */
function toLines(content: string): { lines: string[]; endsWithNewline: boolean } {
  if (content.length === 0) return { lines: [], endsWithNewline: true }
  const endsWithNewline = content.endsWith('\n')
  const lines = content.split('\n')
  if (endsWithNewline) lines.pop()
  return { lines, endsWithNewline }
}

const NO_NEWLINE = '\\ No newline at end of file'

export function renderCreateDiff(path: string, content: string): string {
  const { lines, endsWithNewline } = toLines(content)
  const header = [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`]
  const body = lines.map((line) => `+${line}`)
  if (!endsWithNewline && content.length > 0) body.push(NO_NEWLINE)
  return [...header, ...body].join('\n') + '\n'
}

/** Complete deletion of an existing file. */
export function renderRemoveDiff(path: string, content: string): string {
  const { lines, endsWithNewline } = toLines(content)
  const header = [`--- a/${path}`, `+++ /dev/null`, `@@ -1,${lines.length} +0,0 @@`]
  const body = lines.map((line) => `-${line}`)
  if (!endsWithNewline && content.length > 0) body.push(NO_NEWLINE)
  return [...header, ...body].join('\n') + '\n'
}

/**
 * Above this many lines on either side the quadratic common-subsequence table
 * is not worth building; the change is rendered as a complete replacement
 * instead, which is still exact.
 */
const CONTEXT_DIFF_LINE_LIMIT = 4000
const CONTEXT_LINES = 3

type Edit = { readonly kind: ' ' | '-' | '+'; readonly text: string }

/**
 * Longest-common-subsequence edit script. Deterministic and dependency-free:
 * the approved dependency set carries no diff package, and generated files
 * are small enough for the quadratic table.
 */
function editScript(before: readonly string[], after: readonly string[]): Edit[] {
  const rows = before.length
  const columns = after.length
  // lengths[i][j] = LCS length of before[i..] and after[j..]
  const lengths: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  )
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lengths[i]![j] =
        before[i] === after[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }
  const edits: Edit[] = []
  let i = 0
  let j = 0
  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      edits.push({ kind: ' ', text: before[i]! })
      i += 1
      j += 1
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      edits.push({ kind: '-', text: before[i]! })
      i += 1
    } else {
      edits.push({ kind: '+', text: after[j]! })
      j += 1
    }
  }
  while (i < rows) {
    edits.push({ kind: '-', text: before[i]! })
    i += 1
  }
  while (j < columns) {
    edits.push({ kind: '+', text: after[j]! })
    j += 1
  }
  return edits
}

interface Hunk {
  beforeStart: number
  beforeCount: number
  afterStart: number
  afterCount: number
  lines: string[]
}

/** Groups an edit script into unified-diff hunks with CONTEXT_LINES of context. */
function toHunks(edits: readonly Edit[]): Hunk[] {
  const changed = edits.map((edit) => edit.kind !== ' ')
  const keep = edits.map((_, index) =>
    changed
      .slice(Math.max(0, index - CONTEXT_LINES), index + CONTEXT_LINES + 1)
      .some((value) => value),
  )

  const hunks: Hunk[] = []
  let beforeLine = 1
  let afterLine = 1
  let current: Hunk | null = null
  edits.forEach((edit, index) => {
    if (keep[index]) {
      if (!current) {
        current = {
          beforeStart: beforeLine,
          beforeCount: 0,
          afterStart: afterLine,
          afterCount: 0,
          lines: [],
        }
        hunks.push(current)
      }
      current.lines.push(`${edit.kind}${edit.text}`)
      if (edit.kind !== '+') current.beforeCount += 1
      if (edit.kind !== '-') current.afterCount += 1
    } else {
      current = null
    }
    if (edit.kind !== '+') beforeLine += 1
    if (edit.kind !== '-') afterLine += 1
  })
  return hunks
}

/**
 * Unified diff between the exact current bytes and the exact proposed bytes
 * of a file wrkrs owns. Falls back to a complete replacement for files too
 * large for the context algorithm.
 */
export function renderReplaceDiff(path: string, before: string, after: string): string {
  const source = toLines(before)
  const target = toLines(after)
  const header = [`--- a/${path}`, `+++ b/${path}`]

  if (
    source.lines.length > CONTEXT_DIFF_LINE_LIMIT ||
    target.lines.length > CONTEXT_DIFF_LINE_LIMIT
  ) {
    const body = [
      `@@ -1,${source.lines.length} +1,${target.lines.length} @@`,
      ...source.lines.map((line) => `-${line}`),
      ...target.lines.map((line) => `+${line}`),
    ]
    return [...header, ...body].join('\n') + '\n'
  }

  const hunks = toHunks(editScript(source.lines, target.lines))
  const body: string[] = []
  for (const hunk of hunks) {
    body.push(
      `@@ -${hunk.beforeCount === 0 ? 0 : hunk.beforeStart},${hunk.beforeCount} +${
        hunk.afterCount === 0 ? 0 : hunk.afterStart
      },${hunk.afterCount} @@`,
    )
    body.push(...hunk.lines)
  }
  if (!source.endsWithNewline && before.length > 0) body.push(NO_NEWLINE)
  return [...header, ...body].join('\n') + '\n'
}
