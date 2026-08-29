import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Builds dist once per test run so integration tests exercise the compiled CLI. */
export default function setup(): void {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
}
