/** Exit codes shared by every command. */
export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_USAGE = 2

export type ExitCode = typeof EXIT_OK | typeof EXIT_ERROR | typeof EXIT_USAGE

/**
 * A structured, user-facing failure. The code is stable and machine readable;
 * the message is human readable; details are safe to serialize.
 */
export class WrkrsError extends Error {
  readonly code: string
  readonly exitCode: ExitCode
  readonly details: Readonly<Record<string, string | number | boolean | null>>

  constructor(
    code: string,
    message: string,
    options: {
      exitCode?: ExitCode
      details?: Record<string, string | number | boolean | null>
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WrkrsError'
    this.code = code
    this.exitCode = options.exitCode ?? EXIT_ERROR
    this.details = options.details ?? {}
  }
}

export function isWrkrsError(value: unknown): value is WrkrsError {
  return value instanceof WrkrsError
}

export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return String(value)
}
