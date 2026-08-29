import { execFile } from 'node:child_process'

import { COMPILED_CLI } from './temp.js'

export interface CliRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs the compiled CLI as a child process with a non-TTY stdin. */
export function runCompiledCli(
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [COMPILED_CLI, ...args],
      {
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, NO_COLOR: '1', ...options.env },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code as number)
            : error
              ? 1
              : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
    child.stdin?.end()
  })
}

export const ANSI_PATTERN = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m')
