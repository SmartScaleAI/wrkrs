import * as nodePath from 'node:path'

import { err, ok, type Result } from '../core/result.js'

export type PathIssueCode =
  | 'PATH_EMPTY'
  | 'PATH_ABSOLUTE'
  | 'PATH_TRAVERSAL'
  | 'PATH_NUL'
  | 'PATH_RESERVED_NAME'
  | 'PATH_INVALID_CHARACTER'
  | 'PATH_INVALID_SEGMENT'

export interface PathIssue {
  readonly code: PathIssueCode
  readonly message: string
  readonly input: string
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
// Characters that are invalid in file names on at least one supported platform.
const INVALID_CHARACTERS = '<>:"|?*'
const LAST_CONTROL_CHARACTER = 31
const NUL = String.fromCharCode(0)

function hasInvalidCharacter(segment: string): boolean {
  for (const character of segment) {
    const code = character.charCodeAt(0)
    if (code <= LAST_CONTROL_CHARACTER || code === 127) return true
    if (INVALID_CHARACTERS.includes(character)) return true
  }
  return false
}

/**
 * Normalizes a repository-relative path to POSIX form and rejects anything
 * that could escape the repository or behave differently across platforms.
 */
export function normalizeRelativePath(input: string): Result<string, PathIssue> {
  if (input.includes(NUL)) {
    return err({ code: 'PATH_NUL', message: 'Path contains a NUL byte', input })
  }
  const unified = input.replace(/\\/g, '/')
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    return err({ code: 'PATH_ABSOLUTE', message: 'Path must be repository-relative', input })
  }
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) {
    return err({ code: 'PATH_EMPTY', message: 'Path is empty', input })
  }
  for (const segment of segments) {
    if (segment === '..') {
      return err({ code: 'PATH_TRAVERSAL', message: 'Path contains parent traversal', input })
    }
    if (hasInvalidCharacter(segment)) {
      return err({
        code: 'PATH_INVALID_CHARACTER',
        message: 'Path segment contains a character that is invalid on a supported platform',
        input,
      })
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      return err({
        code: 'PATH_RESERVED_NAME',
        message: `Path segment "${segment}" is a reserved device name`,
        input,
      })
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return err({
        code: 'PATH_INVALID_SEGMENT',
        message: `Path segment "${segment}" ends with a dot or space`,
        input,
      })
    }
  }
  return ok(segments.join('/'))
}

/** Parent directories of a normalized relative path, shallowest first. */
export function ancestorDirectories(relativePath: string): string[] {
  const segments = relativePath.split('/')
  const ancestors: string[] = []
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join('/'))
  }
  return ancestors
}

export function parentDirectory(relativePath: string): string | null {
  const index = relativePath.lastIndexOf('/')
  return index === -1 ? null : relativePath.slice(0, index)
}

export function baseName(relativePath: string): string {
  const index = relativePath.lastIndexOf('/')
  return index === -1 ? relativePath : relativePath.slice(index + 1)
}

/** Key used to detect collisions on case-insensitive filesystems. */
export function caseFoldKey(relativePath: string): string {
  return relativePath.normalize('NFC').toLowerCase()
}

export function toSystemPath(root: string, relativePath: string): string {
  return nodePath.join(root, ...relativePath.split('/'))
}

export function joinRelativePath(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join('/')
}

/** Converts an absolute system path beneath root into a normalized relative path. */
export function toRelativePath(root: string, absolutePath: string): Result<string, PathIssue> {
  const relative = nodePath.relative(root, absolutePath)
  return normalizeRelativePath(relative.split(nodePath.sep).join('/'))
}

export function isWithinRoot(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const prefix = root.endsWith(nodePath.sep) ? root : root + nodePath.sep
  return candidate.startsWith(prefix)
}

export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
