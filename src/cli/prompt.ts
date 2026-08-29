import * as readline from 'node:readline/promises'

import type { PromptPort } from '../core/ports.js'

/** Confirmation prompt backed by node:readline/promises. */
export function createReadlinePrompt(options: {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  interactive: boolean
}): PromptPort {
  return {
    interactive: options.interactive,
    async confirm(message) {
      if (!options.interactive) return false
      const rl = readline.createInterface({ input: options.input, output: options.output })
      try {
        const answer = await rl.question(`${message} [y/N] `)
        return /^y(es)?$/i.test(answer.trim())
      } finally {
        rl.close()
      }
    },
  }
}

/** Non-interactive prompt used when stdin is not a terminal or in tests. */
export function createNonInteractivePrompt(): PromptPort {
  return { interactive: false, confirm: async () => false }
}
