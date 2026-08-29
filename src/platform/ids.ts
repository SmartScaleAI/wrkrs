import { randomUUID } from 'node:crypto'

import type { IdPort } from '../core/ports.js'

export const systemIds: IdPort = {
  uuid: () => randomUUID(),
}

/** Deterministic identifiers for tests. */
export function createSequentialIds(): IdPort {
  let counter = 0
  return {
    uuid: () => {
      counter += 1
      return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`
    },
  }
}
