// Renders the committed public JSON Schema from the compiled Zod definition.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { renderConfigJsonSchema } from '../dist/config/json-schema.js'

const target = fileURLToPath(new URL('../schema/wrkrs-config.schema.json', import.meta.url))
mkdirSync(fileURLToPath(new URL('../schema', import.meta.url)), { recursive: true })
writeFileSync(target, renderConfigJsonSchema())
console.log(`wrote ${target}`)
