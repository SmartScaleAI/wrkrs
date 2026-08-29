import type { ClockPort } from '../core/ports.js'

export const systemClock: ClockPort = {
  now: () => new Date(),
}

/** Deterministic clock for tests: returns the same instant unless stepped. */
export function createFixedClock(iso: string, stepMs = 0): ClockPort {
  let current = new Date(iso).getTime()
  return {
    now: () => {
      const value = new Date(current)
      current += stepMs
      return value
    },
  }
}

export function formatTimestamp(date: Date): string {
  return date.toISOString()
}
