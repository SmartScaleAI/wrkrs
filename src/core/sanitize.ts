/**
 * Reject-then-render for untrusted identifiers. A value that fails validation
 * never reaches a projection; diagnostics show only a bounded, escaped rendering.
 */

export const IDENTIFIER_MAX_LENGTH = 64
export const NOTE_MAX_LENGTH = 120
export const UNTRUSTED_RENDER_MAX = 32

/** Server names, executables, and similar identifiers that must YAML-round-trip unquoted. */
export const CONNECTION_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9.-]{0,62}$/

const MARKDOWN_OR_YAML_UNSAFE = /[`#[\]*'":{}&!?|>%@\\,]/

export function isConnectionIdentifier(value: string): boolean {
  return CONNECTION_IDENTIFIER_PATTERN.test(value) && !MARKDOWN_OR_YAML_UNSAFE.test(value)
}

export function isConnectionNote(value: string): boolean {
  if (value.length === 0 || value.length > NOTE_MAX_LENGTH) return false
  if (!/^[\t\x20-\x7e]+$/.test(value)) return false
  if (/[\r\n\x1b]/.test(value)) return false
  return !MARKDOWN_OR_YAML_UNSAFE.test(value)
}

export function isBareExecutableName(value: string): boolean {
  if (!isConnectionIdentifier(value)) return false
  if (value.includes('/') || value.includes('\\')) return false
  if (/[;$`|&<>()]/.test(value)) return false
  return true
}

/**
 * Bounded, escaped rendering of an untrusted string. Control characters, ANSI,
 * and overlong values never appear raw.
 */
export function renderUntrusted(value: string, max = UNTRUSTED_RENDER_MAX): string {
  let rendered = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    let piece: string
    if (code < 0x20 || code === 0x7f || code === 0x1b) {
      piece = `\\u${code.toString(16).padStart(4, '0')}`
    } else if (char === '\\') {
      piece = '\\\\'
    } else {
      piece = char
    }
    if (rendered.length + piece.length > max) {
      rendered += '…'
      break
    }
    rendered += piece
  }
  return rendered
}

export function renderUntrustedList(values: readonly string[], maxTotal = 200): string {
  const parts: string[] = []
  let used = 0
  for (const value of values) {
    const piece = renderUntrusted(value)
    if (used > 0 && used + piece.length + 2 > maxTotal) {
      parts.push('…')
      break
    }
    parts.push(piece)
    used += piece.length + 2
  }
  return parts.join(', ')
}
