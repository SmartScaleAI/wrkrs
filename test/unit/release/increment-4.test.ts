import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { REPOSITORY_ROOT } from '../../helpers/temp.js'

describe('Increment 4 release hardening', () => {
  it('144: the verify workflow runs Ubuntu and macOS on the engine floor and Node 24', () => {
    const workflow = readFileSync(
      path.join(REPOSITORY_ROOT, '.github', 'workflows', 'verify.yml'),
      'utf8',
    )
    expect(workflow).toContain('ubuntu-latest')
    expect(workflow).toContain('macos-latest')
    expect(workflow).toContain('22.12.0')
    expect(workflow).toContain('24')
    expect(workflow).toContain('npm run verify')
    expect(workflow).toContain('contents: read')
  })

  it('145: Windows CI proves fail-closed without running the POSIX verify suite', () => {
    const workflow = readFileSync(
      path.join(REPOSITORY_ROOT, '.github', 'workflows', 'verify.yml'),
      'utf8',
    )
    expect(workflow).toContain('windows-latest')
    expect(workflow).toContain('scripts/windows-fail-closed.mjs')
    expect(workflow).not.toMatch(/windows-latest[\s\S]*npm run verify/)
  })

  it('148/149: README documents connections and the machine protocol; the package stays unpublished', () => {
    const readme = readFileSync(path.join(REPOSITORY_ROOT, 'README.md'), 'utf8')
    expect(readme).toContain('--questions')
    expect(readme).toContain('--answers')
    expect(readme).toContain('--expect-digest')
    expect(readme).toContain('connections')
    expect(readme).not.toContain('npm publish')
    const pkg = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as {
      private?: boolean
      license?: string
      engines: { node: string }
      bin: Record<string, string>
    }
    expect(pkg.private).toBe(true)
    expect(pkg.license).toBe('MIT')
    expect(pkg.engines.node).toBe('>=22.12')
    expect(Object.keys(pkg.bin)).toEqual(['wrkrs'])
  })
})
