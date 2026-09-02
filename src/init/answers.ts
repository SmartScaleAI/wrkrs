import { isHash } from '../platform/hash.js'
import { err, ok, type Result } from '../core/result.js'
import { renderUntrusted } from '../core/sanitize.js'

export const ANSWERS_SCHEMA_VERSION = 1

export interface AnswersDocument {
  readonly schemaVersion: typeof ANSWERS_SCHEMA_VERSION
  readonly questionSetDigest: string
  readonly answers: Readonly<Record<string, string>>
}

export interface AnswersError {
  readonly code: string
  readonly message: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Detects duplicate keys in a JSON object (JSON.parse keeps the last duplicate silently). */
export function jsonHasDuplicateKeys(text: string): boolean {
  type Frame =
    | { readonly kind: 'object'; keys: Set<string>; expect: 'key' | 'value' }
    | { readonly kind: 'array' }
  const stack: Frame[] = []
  let i = 0
  const n = text.length
  const peek = (): string => text[i] ?? ''
  const skipWs = (): void => {
    while (i < n && /[ \t\r\n]/.test(peek())) i += 1
  }
  const skipString = (): boolean => {
    if (peek() !== '"') return false
    i += 1
    while (i < n) {
      const char = text[i]!
      if (char === '\\') {
        i += 2
        continue
      }
      if (char === '"') {
        i += 1
        return true
      }
      i += 1
    }
    return false
  }
  const afterValue = (): void => {
    const frame = stack[stack.length - 1]
    if (frame?.kind === 'object') frame.expect = 'key'
  }
  skipWs()
  while (i < n) {
    skipWs()
    const char = peek()
    if (char === '') break
    const frame = stack[stack.length - 1]
    if (char === '{') {
      stack.push({ kind: 'object', keys: new Set(), expect: 'key' })
      i += 1
      continue
    }
    if (char === '[') {
      stack.push({ kind: 'array' })
      i += 1
      continue
    }
    if (char === '}') {
      stack.pop()
      i += 1
      afterValue()
      skipWs()
      if (peek() === ',') i += 1
      continue
    }
    if (char === ']') {
      stack.pop()
      i += 1
      afterValue()
      skipWs()
      if (peek() === ',') i += 1
      continue
    }
    if (char === ',') {
      i += 1
      continue
    }
    if (frame?.kind === 'object' && frame.expect === 'key') {
      const start = i
      if (!skipString()) return false
      let key: string
      try {
        key = JSON.parse(text.slice(start, i)) as string
      } catch {
        return false
      }
      if (frame.keys.has(key)) return true
      frame.keys.add(key)
      skipWs()
      if (peek() !== ':') return false
      i += 1
      frame.expect = 'value'
      continue
    }
    if (char === '"') {
      if (!skipString()) return false
      afterValue()
      continue
    }
    while (i < n && !/[,:[\]{}" \t\r\n]/.test(peek())) i += 1
    afterValue()
  }
  return false
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return Buffer.from(text, 'utf8').equals(Buffer.from(bytes))
  } catch {
    return false
  }
}

export function parseAnswersBytes(bytes: Uint8Array): Result<AnswersDocument, AnswersError> {
  if (!isUtf8(bytes)) {
    return err({ code: 'ANSWERS_NOT_UTF8', message: 'Answers file is not valid UTF-8' })
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (jsonHasDuplicateKeys(text)) {
    return err({ code: 'ANSWERS_DUPLICATE_KEY', message: 'Answers JSON contains a duplicate key' })
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return err({ code: 'ANSWERS_JSON_INVALID', message: 'Answers file is not valid JSON' })
  }
  if (!isPlainObject(value)) {
    return err({ code: 'ANSWERS_NOT_AN_OBJECT', message: 'Answers document must be a JSON object' })
  }
  const allowed = new Set(['schemaVersion', 'questionSetDigest', 'answers'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return err({
        code: 'ANSWERS_UNKNOWN_KEY',
        message: 'Answers document contains an unknown key',
      })
    }
  }
  if (value['schemaVersion'] !== ANSWERS_SCHEMA_VERSION) {
    return err({
      code: 'ANSWERS_SCHEMA_VERSION_MISSING',
      message: 'Answers document schemaVersion must be 1',
    })
  }
  const digest = value['questionSetDigest']
  if (typeof digest !== 'string' || !isHash(digest)) {
    return err({
      code: 'ANSWERS_DIGEST_MISSING',
      message: 'Answers document questionSetDigest is missing or invalid',
    })
  }
  const answers = value['answers']
  if (answers === undefined) {
    return ok({ schemaVersion: 1, questionSetDigest: digest, answers: {} })
  }
  if (!isPlainObject(answers)) {
    return err({ code: 'ANSWERS_INVALID', message: 'Answers must be an object of question ids' })
  }
  const mapped: Record<string, string> = {}
  for (const [questionId, choiceId] of Object.entries(answers)) {
    if (typeof choiceId !== 'string') {
      return err({ code: 'ANSWERS_INVALID', message: 'Each answer must be a choice id string' })
    }
    mapped[questionId] = choiceId
    void renderUntrusted(questionId)
  }
  return ok({ schemaVersion: 1, questionSetDigest: digest, answers: mapped })
}
