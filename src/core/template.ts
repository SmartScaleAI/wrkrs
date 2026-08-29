/**
 * Strict placeholder rendering for packaged templates. Unknown placeholders
 * and unused variables are errors so a template and its renderer cannot
 * silently diverge.
 */
const PLACEHOLDER = /\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g

export function renderTemplate(
  template: string,
  variables: Readonly<Record<string, string>>,
): string {
  const used = new Set<string>()
  const rendered = template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = variables[key]
    if (value === undefined) {
      throw new Error(`Template placeholder "${key}" has no value`)
    }
    used.add(key)
    return value
  })
  for (const key of Object.keys(variables)) {
    if (!used.has(key)) {
      throw new Error(`Template variable "${key}" is not used by the template`)
    }
  }
  return rendered
}
