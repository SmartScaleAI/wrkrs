import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { REPOSITORY_ROOT } from '../../helpers/temp.js'

const SRC = path.join(REPOSITORY_ROOT, 'src')

/** Allowed import direction between top-level source modules. */
const ALLOWED: Record<string, readonly string[]> = {
  core: ['core'],
  platform: ['core', 'platform'],
  config: ['core', 'platform', 'config'],
  presets: ['core', 'presets'],
  repository: ['core', 'platform', 'config', 'repository'],
  adapters: ['core', 'platform', 'config', 'presets', 'adapters'],
  providers: ['core', 'providers'],
  planner: ['core', 'platform', 'config', 'planner'],
  writer: ['core', 'platform', 'config', 'planner', 'writer'],
  check: ['core', 'platform', 'config', 'adapters', 'repository', 'check'],
  init: [
    'core',
    'platform',
    'config',
    'presets',
    'adapters',
    'providers',
    'repository',
    'planner',
    'writer',
    'check',
    'init',
  ],
  cli: [
    'core',
    'platform',
    'config',
    'presets',
    'adapters',
    'providers',
    'repository',
    'planner',
    'writer',
    'check',
    'init',
    'cli',
  ],
}

function listSourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry)
    if (statSync(absolute).isDirectory()) files.push(...listSourceFiles(absolute))
    else if (entry.endsWith('.ts')) files.push(absolute)
  }
  return files.sort()
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const specifiers: string[] = []
  const pattern = /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm
  for (const match of text.matchAll(pattern)) specifiers.push(match[1]!)
  return specifiers
}

function layerOf(file: string): string {
  return path.relative(SRC, file).split(path.sep)[0]!
}

describe('dependency direction', () => {
  const files = listSourceFiles(SRC)

  it('respects the approved module boundaries', () => {
    const violations: string[] = []
    for (const file of files) {
      const layer = layerOf(file)
      const allowed = ALLOWED[layer]
      expect(allowed, `unknown layer for ${file}`).toBeDefined()
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith('.')) continue
        const target = path.resolve(path.dirname(file), specifier)
        const targetLayer = layerOf(target)
        if (!allowed!.includes(targetLayer)) {
          violations.push(`${path.relative(SRC, file)} -> ${path.relative(SRC, target)}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps the core free of runtime, framework, and filesystem dependencies', () => {
    for (const file of files.filter((candidate) => layerOf(candidate) === 'core')) {
      for (const specifier of importsOf(file)) {
        expect(specifier.startsWith('.'), `${path.relative(SRC, file)} imports ${specifier}`).toBe(
          true,
        )
      }
    }
    for (const file of files.filter((candidate) => layerOf(candidate) === 'writer')) {
      expect(
        importsOf(file).some(
          (specifier) => specifier.includes('adapters') || specifier.includes('claude'),
        ),
      ).toBe(false)
    }
  })

  it('has no import cycles', () => {
    const graph = new Map<string, string[]>()
    for (const file of files) {
      graph.set(
        file,
        importsOf(file)
          .filter((specifier) => specifier.startsWith('.'))
          .map((specifier) => path.resolve(path.dirname(file), specifier).replace(/\.js$/, '.ts')),
      )
    }
    const state = new Map<string, 'visiting' | 'done'>()
    const cycles: string[] = []
    const visit = (node: string, trail: string[]) => {
      const current = state.get(node)
      if (current === 'done') return
      if (current === 'visiting') {
        cycles.push([...trail, node].map((item) => path.relative(SRC, item)).join(' -> '))
        return
      }
      state.set(node, 'visiting')
      for (const next of graph.get(node) ?? []) visit(next, [...trail, node])
      state.set(node, 'done')
    }
    for (const file of files) visit(file, [])
    expect(cycles).toEqual([])
  })
})
