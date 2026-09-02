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
    async choose(message, choices, defaultId) {
      if (!options.interactive) return defaultId
      const rl = readline.createInterface({ input: options.input, output: options.output })
      try {
        const lines = [
          message,
          ...choices.map((choice, index) => `  ${index + 1}. ${choice.label} (${choice.id})`),
        ]
        const answer = await rl.question(`${lines.join('\n')}\nChoice [${defaultId}]: `)
        const trimmed = answer.trim()
        if (trimmed === '') return defaultId
        const byId = choices.find((choice) => choice.id === trimmed)
        if (byId) return byId.id
        const index = Number.parseInt(trimmed, 10)
        if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
          return choices[index - 1]!.id
        }
        return defaultId
      } finally {
        rl.close()
      }
    },
  }
}

/** Non-interactive prompt used when stdin is not a terminal or in tests. */
export function createNonInteractivePrompt(): PromptPort {
  return {
    interactive: false,
    confirm: async () => false,
    choose: async (_m, _c, defaultId) => defaultId,
  }
}
