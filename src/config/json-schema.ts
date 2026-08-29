import { z } from 'zod'

import { configSchemaV1 } from './schema.js'

export const CONFIG_JSON_SCHEMA_TITLE = 'wrkrs configuration (schema version 1)'

/**
 * Emits the public JSON Schema from the Zod definition. The committed copy in
 * schema/ and the installed .wrkrs/schema.json are both rendered from here, and
 * a unit test fails if the committed copy drifts.
 */
export function generateConfigJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(configSchemaV1, { io: 'input', target: 'draft-2020-12' })
  const { $schema, ...rest } = generated as Record<string, unknown>
  return {
    $schema: $schema ?? 'https://json-schema.org/draft/2020-12/schema',
    title: CONFIG_JSON_SCHEMA_TITLE,
    ...rest,
  }
}

export function renderConfigJsonSchema(): string {
  return JSON.stringify(generateConfigJsonSchema(), null, 2) + '\n'
}
