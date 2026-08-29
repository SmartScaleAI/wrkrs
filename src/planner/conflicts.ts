import type { Conflict, ConflictFamily } from '../core/plan.js'

export function conflict(
  family: ConflictFamily,
  code: string,
  path: string | null,
  message: string,
  remediation: string,
): Conflict {
  return { family, code, path, message, remediation }
}

export function sortConflicts(conflicts: readonly Conflict[]): Conflict[] {
  return [...conflicts].sort((a, b) => {
    const pa = a.path ?? ''
    const pb = b.path ?? ''
    if (pa !== pb) return pa < pb ? -1 : 1
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0
  })
}

export const FUTURE_UPDATE_REMEDIATION =
  'An existing wrkrs installation is present. Changing it requires the planned `wrkrs update` command; init never modifies an installed repository'
