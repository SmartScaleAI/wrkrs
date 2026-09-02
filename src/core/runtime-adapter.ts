import type { WrkrsConfig } from './configuration.js'
import type { ResolvedBinding } from './connections.js'
import type { Diagnostic } from './diagnostics.js'
import type { Finding } from './findings.js'
import type { OwnershipManifest } from './ownership.js'
import type { DesiredComponent } from './plan.js'
import type { FileSystemPort } from './ports.js'
import type { RosterRecommendation } from './roster.js'
import type { RepositorySnapshot } from './snapshot.js'

export interface PreservedComponent {
  readonly path: string
  readonly kind: string
  readonly description: string
}

export interface AdapterAnalysis {
  readonly preserved: readonly PreservedComponent[]
  readonly findings: readonly Finding[]
}

export interface CompiledRole {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly content: string
}

export interface AdapterCompileInput {
  readonly roster: RosterRecommendation
  readonly config: WrkrsConfig
  readonly roles: readonly CompiledRole[]
  readonly connections?: readonly ResolvedBinding[]
}

export interface AdapterValidationContext {
  readonly root: string
  readonly fs: FileSystemPort
  readonly config: WrkrsConfig | null
  readonly manifest: OwnershipManifest | null
}

export interface RuntimeAdapter {
  readonly id: string
  readonly version: number
  analyze(snapshot: RepositorySnapshot): AdapterAnalysis
  compile(input: AdapterCompileInput): readonly DesiredComponent[]
  validate(context: AdapterValidationContext): Promise<readonly Diagnostic[]>
}
