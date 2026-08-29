import type { RuntimeAdapterRegistry } from '../adapters/registry.js'
import type { PromptPort } from '../core/ports.js'
import type { ProviderRegistry } from '../core/provider.js'
import type { RosterPreset } from '../core/roster.js'
import type { InitPorts } from '../init/init.js'
import type { Styler } from './output/human-reporter.js'

export interface CliServices {
  readonly wrkrsVersion: string
  readonly ports: InitPorts
  readonly prompt: PromptPort
  readonly preset: RosterPreset
  readonly adapters: RuntimeAdapterRegistry
  readonly providers: ProviderRegistry
}

export interface CliStreams {
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
}

export interface CliContext {
  readonly services: CliServices
  readonly streams: CliStreams
  readonly style: Styler
}
