import { constants as fsConstants, promises as fsp, type Stats } from 'node:fs'
import * as nodePath from 'node:path'

import type { InputDocument, InputDocumentError, InputDocumentPort } from '../core/ports.js'
import { err, ok, type Result } from '../core/result.js'

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
export const ANSWERS_DOCUMENT_MAX_BYTES = 64 * 1024

function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === 'string' ? code : 'EUNKNOWN'
}

function identity(stats: Stats): string {
  return `${stats.dev}:${stats.ino}`
}

function fail(code: string, message: string): Result<InputDocument, InputDocumentError> {
  return err({ code, message })
}

/** Dedicated read-only input-document port. Never writes. Never uses the repository FS port. */
export function createNodeInputDocument(): InputDocumentPort {
  return {
    async read(supplied, options) {
      const resolved = nodePath.isAbsolute(supplied)
        ? nodePath.normalize(supplied)
        : nodePath.resolve(options.cwd, supplied)
      let listed: Stats
      try {
        listed = await fsp.lstat(resolved)
      } catch (error) {
        const code = errnoOf(error)
        if (code === 'ENOENT') return fail('ANSWERS_NOT_FOUND', 'Answers file was not found')
        return fail('ANSWERS_UNREADABLE', 'Answers file could not be inspected')
      }
      if (listed.isSymbolicLink()) {
        return fail(
          'ANSWERS_SYMLINK',
          'Answers path must be a regular file; a final symlink is rejected',
        )
      }
      if (!listed.isFile()) {
        return fail('ANSWERS_NOT_A_FILE', 'Answers path must be a regular file')
      }
      if (listed.size > options.maxBytes) {
        return fail('ANSWERS_TOO_LARGE', 'Answers file exceeds the 64 KiB limit')
      }
      let handle: Awaited<ReturnType<typeof fsp.open>> | undefined
      try {
        handle = await fsp.open(resolved, fsConstants.O_RDONLY | O_NOFOLLOW)
        const opened = await handle.stat()
        if (identity(opened) !== identity(listed) || !opened.isFile()) {
          return fail('ANSWERS_CHANGED', 'Answers file changed while it was being opened')
        }
        if (opened.size > options.maxBytes) {
          return fail('ANSWERS_TOO_LARGE', 'Answers file exceeds the 64 KiB limit')
        }
        const bytes = Buffer.alloc(opened.size)
        const read = await handle.read(bytes, 0, opened.size, 0)
        if (read.bytesRead !== opened.size) {
          return fail('ANSWERS_UNREADABLE', 'Answers file could not be read completely')
        }
        return ok({ bytes: new Uint8Array(bytes) })
      } catch (error) {
        const code = errnoOf(error)
        if (code === 'ELOOP' || code === 'EEXIST') {
          return fail(
            'ANSWERS_SYMLINK',
            'Answers path must be a regular file; a final symlink is rejected',
          )
        }
        return fail('ANSWERS_UNREADABLE', 'Answers file could not be read')
      } finally {
        await handle?.close().catch(() => undefined)
      }
    },
  }
}
