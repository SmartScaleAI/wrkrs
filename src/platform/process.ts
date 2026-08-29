import { execFile } from 'node:child_process'

import type { ProcessPort, ProcessResult } from '../core/ports.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_BUFFER = 16 * 1024 * 1024

/** Executes programs with an argument array and never through a shell. */
export function createNodeProcess(): ProcessPort {
  return {
    run(command, args, options = {}): Promise<ProcessResult> {
      return new Promise((resolve) => {
        const execOptions: Parameters<typeof execFile>[2] = {
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          encoding: 'utf8',
        }
        if (options.cwd !== undefined) execOptions.cwd = options.cwd
        execFile(command, [...args], execOptions, (error, stdout, stderr) => {
          const out = String(stdout)
          const errText = String(stderr)
          if (!error) {
            resolve({ started: true, exitCode: 0, stdout: out, stderr: errText, errorCode: null })
            return
          }
          const failure = error as NodeJS.ErrnoException & { code?: number | string }
          if (typeof failure.code === 'string') {
            resolve({
              started: false,
              exitCode: null,
              stdout: out,
              stderr: errText,
              errorCode: failure.code,
            })
            return
          }
          resolve({
            started: true,
            exitCode: typeof failure.code === 'number' ? failure.code : null,
            stdout: out,
            stderr: errText,
            errorCode: null,
          })
        })
      })
    },
  }
}
