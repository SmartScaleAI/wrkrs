// Copies packaged Markdown templates (roles, agents, skills) from src to dist.
import { cpSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chmodSync } from 'node:fs'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = new URL('../src', import.meta.url)
const destination = new URL('../dist', import.meta.url)

cpSync(fileURLToPath(source), fileURLToPath(destination), {
  recursive: true,
  filter: (path) => statSync(path).isDirectory() || path.endsWith('.md'),
})
chmodSync(`${root}dist/cli/index.js`, 0o755)
console.log('copied templates to dist/')
