import type { ReadCapabilityId } from '../core/capabilities.js'
import { questionIdFor, READ_CAPABILITY_IDS } from '../core/capabilities.js'
import type { BindingKind, BindingScope, ConnectionBinding } from '../core/connections.js'
import { mcpServerMatchesProvider, PROVIDER_IDS, type ProviderId } from '../core/connections.js'
import { isConnectionIdentifier } from '../core/sanitize.js'
import type { ProviderRegistry } from '../core/provider.js'
import { hashCanonicalJson } from '../platform/hash.js'

export const SKIP_CHOICE_ID = 'skip'
export const MANUAL_CHOICE_ID = 'manual'

export interface SetupChoice {
  readonly id: string
  readonly kind: 'skip' | BindingKind
  readonly provider?: ProviderId
  readonly server?: string
  readonly executable?: string
  readonly scope?: BindingScope
  readonly verification?: 'verified-project' | 'verified-environment'
}

export interface SetupQuestion {
  readonly id: string
  readonly capability: ReadCapabilityId
  readonly prompt: string
  readonly default: typeof SKIP_CHOICE_ID
  readonly choices: readonly SetupChoice[]
}

export interface QuestionSet {
  readonly questions: readonly SetupQuestion[]
  readonly questionSetDigest: string
}

const PROMPTS: Record<ReadCapabilityId, string> = {
  'source-control-context': 'What supplies source-control context?',
  'pull-request-context': 'What supplies pull-request context?',
  'work-item-context': 'What supplies work items?',
  'design-file-context': 'What supplies design files?',
  'design-comment-context': 'What supplies design comments?',
}

export function choiceIdFor(parts: {
  provider: ProviderId
  kind: BindingKind
  scope?: BindingScope
  server?: string
  executable?: string
}): string {
  const tokens = [`provider:${parts.provider}`, `kind:${parts.kind}`]
  if (parts.scope) tokens.push(`scope:${parts.scope}`)
  if (parts.server) tokens.push(`server:${parts.server}`)
  if (parts.executable) tokens.push(`executable:${parts.executable}`)
  return tokens.join(':')
}

export function discoverQuestionSet(input: {
  readonly providers: ProviderRegistry
  readonly projectServers: readonly string[]
  readonly cliPresent: boolean
}): QuestionSet {
  const servers = [...input.projectServers].filter(isConnectionIdentifier).sort()
  const questions = READ_CAPABILITY_IDS.map((capability) => {
    const choices: SetupChoice[] = [
      { id: SKIP_CHOICE_ID, kind: 'skip' },
      { id: MANUAL_CHOICE_ID, kind: 'manual', provider: 'manual' },
    ]
    for (const providerId of PROVIDER_IDS) {
      const provider = input.providers.get(providerId)
      if (!provider || !provider.capabilities.includes(capability)) continue
      if (provider.kinds.includes('mcp-server')) {
        for (const server of servers) {
          if (!mcpServerMatchesProvider(provider.id, server)) continue
          choices.push({
            id: choiceIdFor({
              provider: provider.id,
              kind: 'mcp-server',
              scope: 'project',
              server,
            }),
            kind: 'mcp-server',
            provider: provider.id,
            server,
            scope: 'project',
            verification: 'verified-project',
          })
        }
      }
      if (provider.kinds.includes('cli') && input.cliPresent) {
        choices.push({
          id: choiceIdFor({ provider: provider.id, kind: 'cli', executable: 'gh' }),
          kind: 'cli',
          provider: provider.id,
          executable: 'gh',
          verification: 'verified-environment',
        })
      }
    }
    return {
      id: questionIdFor(capability),
      capability,
      prompt: PROMPTS[capability],
      default: SKIP_CHOICE_ID as typeof SKIP_CHOICE_ID,
      choices,
    }
  })
  return {
    questions,
    questionSetDigest: hashCanonicalJson({ schemaVersion: 1, questions }),
  }
}

export function bindingFromChoice(choice: SetupChoice): ConnectionBinding | null {
  if (choice.kind === 'skip' || choice.id === SKIP_CHOICE_ID) return null
  if (choice.kind === 'manual' || choice.provider === 'manual') {
    return { provider: 'manual', kind: 'manual' }
  }
  if (choice.kind === 'cli' && choice.provider === 'github' && choice.executable) {
    return { provider: 'github', kind: 'cli', executable: choice.executable }
  }
  if (choice.kind === 'mcp-server' && choice.provider && choice.server && choice.scope) {
    return {
      provider: choice.provider,
      kind: 'mcp-server',
      server: choice.server,
      scope: choice.scope,
    }
  }
  return null
}

export function connectionsFromAnswers(
  questionSet: QuestionSet,
  answers: Readonly<Record<string, string>>,
): { connections: import('../core/configuration.js').ConnectionMap; error: string | null } {
  const seen = new Set<string>()
  const connections: import('../core/configuration.js').ConnectionMap = {}
  const mutable: Record<string, ConnectionBinding> = {}
  for (const [questionId, choiceId] of Object.entries(answers)) {
    if (seen.has(questionId)) return { connections, error: 'duplicate answer' }
    seen.add(questionId)
    const question = questionSet.questions.find((candidate) => candidate.id === questionId)
    if (!question) return { connections, error: 'unknown question' }
    const choice = question.choices.find((candidate) => candidate.id === choiceId)
    if (!choice) return { connections, error: 'unknown choice' }
    const binding = bindingFromChoice(choice)
    if (binding) mutable[question.capability] = binding
  }
  return { connections: mutable, error: null }
}
