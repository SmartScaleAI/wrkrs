/**
 * Minimal YAML-like frontmatter reader for generated Markdown components.
 * Only simple `key: value` lines are supported, which is all wrkrs emits and
 * all that validation needs. Values are returned as trimmed strings with
 * surrounding quotes removed.
 */
export interface Frontmatter {
  readonly fields: ReadonlyMap<string, string>
  readonly body: string
}

export function parseFrontmatter(text: string): Frontmatter | null {
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---\n', 4)
  if (end === -1) return null
  const block = text.slice(4, end)
  const fields = new Map<string, string>()
  for (const line of block.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator === -1) return null
    const key = line.slice(0, separator).trim()
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2')
    if (key === '') return null
    fields.set(key, value)
  }
  return { fields, body: text.slice(end + 5) }
}

export function stripFrontmatter(text: string): string {
  return parseFrontmatter(text)?.body ?? text
}
