/**
 * Unified diff rendering. The first slice only creates files, so the diff is
 * a complete addition against /dev/null in standard unified format.
 */
export function renderCreateDiff(path: string, content: string): string {
  const lines = content.length === 0 ? [] : content.split('\n')
  const endsWithNewline = content.endsWith('\n')
  if (endsWithNewline) lines.pop()
  const count = lines.length
  const header = [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${count} @@`]
  const body = lines.map((line) => `+${line}`)
  if (!endsWithNewline && content.length > 0) {
    body.push('\\ No newline at end of file')
  }
  return [...header, ...body].join('\n') + '\n'
}
