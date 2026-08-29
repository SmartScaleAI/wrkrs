import { createFinding, type Finding } from '../../core/findings.js'
import type { ProjectSignal } from '../../core/snapshot.js'
import type { ScanContext } from '../snapshot.js'

export interface ProjectDetection {
  readonly signals: readonly ProjectSignal[]
  readonly findings: readonly Finding[]
}

const BACKEND_NODE_DEPENDENCIES = ['express', 'fastify', 'koa', 'hono', '@nestjs/core']
const LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ['package-lock.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
]
const MONOREPO_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['pnpm-workspace.yaml', 'pnpm workspace'],
  ['lerna.json', 'lerna'],
  ['nx.json', 'nx'],
  ['turbo.json', 'turborepo'],
]
const LANGUAGE_MANIFESTS: ReadonlyArray<readonly [string, string, string]> = [
  ['Package.swift', 'apple.swift-package', 'Swift package manifest'],
  ['pyproject.toml', 'python.pyproject', 'Python project manifest'],
  ['requirements.txt', 'python.requirements', 'Python requirements file'],
  ['go.mod', 'go.module', 'Go module manifest'],
  ['Cargo.toml', 'rust.cargo', 'Rust crate manifest'],
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function dependencyKeys(packageJson: Record<string, unknown>): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const block = packageJson[section]
    if (!isRecord(block)) continue
    for (const name of Object.keys(block)) {
      if (!result.has(name)) result.set(name, `${section}.${name}`)
    }
  }
  return result
}

/**
 * Bounded root-level project detection. Only registered marker files are read,
 * nothing is executed, and evidence is limited to marker paths and dependency
 * keys so findings are safe to serialize.
 */
export async function detectProject(context: ScanContext): Promise<ProjectDetection> {
  const signals: ProjectSignal[] = []
  const findings: Finding[] = []

  const packageText = await context.readText('package.json')
  if (packageText !== null) {
    let packageJson: unknown
    try {
      packageJson = JSON.parse(packageText)
    } catch {
      packageJson = null
    }
    if (!isRecord(packageJson)) {
      findings.push(
        createFinding('PROJECT_PACKAGE_JSON_INVALID', 'warning', 'package.json is not valid JSON', {
          path: 'package.json',
        }),
      )
    } else {
      signals.push({ id: 'node.package', path: 'package.json', detail: 'package manifest' })
      const dependencies = dependencyKeys(packageJson)
      const typescriptKey = dependencies.get('typescript')
      if (typescriptKey) {
        signals.push({ id: 'typescript.dependency', path: 'package.json', detail: typescriptKey })
      }
      const reactKey = dependencies.get('react')
      if (reactKey) {
        signals.push({ id: 'web.react', path: 'package.json', detail: reactKey })
      }
      const nextKey = dependencies.get('next')
      if (nextKey) {
        signals.push({ id: 'web.nextjs', path: 'package.json', detail: nextKey })
      }
      for (const dependency of BACKEND_NODE_DEPENDENCIES) {
        const key = dependencies.get(dependency)
        if (key) {
          signals.push({ id: 'backend.node', path: 'package.json', detail: key })
        }
      }
      if (Array.isArray(packageJson['workspaces']) || isRecord(packageJson['workspaces'])) {
        signals.push({ id: 'monorepo.workspaces', path: 'package.json', detail: 'workspaces' })
      }
    }
  }

  for (const [file, manager] of LOCKFILES) {
    const stat = await context.stat(file)
    if (stat && stat.kind === 'file') {
      signals.push({ id: 'node.lockfile', path: file, detail: manager })
    }
  }

  const tsconfig = await context.stat('tsconfig.json')
  if (tsconfig && tsconfig.kind === 'file') {
    signals.push({ id: 'typescript.tsconfig', path: 'tsconfig.json', detail: 'TypeScript config' })
  }

  for (const [file, marker] of MONOREPO_MARKERS) {
    const stat = await context.stat(file)
    if (stat && stat.kind === 'file') {
      signals.push({ id: 'monorepo.marker', path: file, detail: marker })
    }
  }

  for (const [file, id, detail] of LANGUAGE_MANIFESTS) {
    const stat = await context.stat(file)
    if (stat && stat.kind === 'file') {
      signals.push({ id, path: file, detail })
    }
  }

  const rootEntries = await context.listDirectory('')
  for (const entry of rootEntries) {
    if (entry.kind !== 'directory') continue
    if (entry.name.endsWith('.xcodeproj')) {
      signals.push({ id: 'apple.xcodeproj', path: entry.name, detail: 'Xcode project' })
    } else if (entry.name.endsWith('.xcworkspace')) {
      signals.push({ id: 'apple.xcworkspace', path: entry.name, detail: 'Xcode workspace' })
    }
  }

  signals.sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0
  })

  for (const signal of signals) {
    findings.push(
      createFinding('PROJECT_SIGNAL', 'info', `Detected ${signal.id} (${signal.detail})`, {
        path: signal.path,
        evidence: [
          { key: 'signal', value: signal.id },
          { key: 'detail', value: signal.detail },
        ],
      }),
    )
  }
  if (signals.length === 0) {
    findings.push(
      createFinding(
        'PROJECT_NO_SIGNALS',
        'info',
        'No known project markers were detected; the roster receives no specialization',
      ),
    )
  }

  return { signals, findings }
}
