import { AI_VAULT_AGENTS, type AiVaultAgent } from './ai-vault-types'

// Frozen vocabulary for peers that predate agent-list negotiation.
export const LEGACY_SESSION_SEARCH_AGENTS = [
  'claude',
  'codebuddy',
  'codex',
  'hermes',
  'pi',
  'omp',
  'prime-agent',
  'cursor',
  'gemini',
  'antigravity',
  'rovo',
  'copilot',
  'opencode',
  'opencode2',
  'zcode',
  'grok',
  'openclaw',
  'devin',
  'droid',
  'cline',
  'kimi',
  'muse'
] as const satisfies readonly AiVaultAgent[]

export function sessionSearchAgentsForPeer(
  supportedAgents: readonly string[] | undefined,
  supportsQoderHistory: boolean | undefined
): AiVaultAgent[] {
  if (supportedAgents !== undefined) {
    return AI_VAULT_AGENTS.filter((agent) => supportedAgents.includes(agent))
  }
  return supportsQoderHistory === true
    ? [...LEGACY_SESSION_SEARCH_AGENTS, 'qoder']
    : [...LEGACY_SESSION_SEARCH_AGENTS]
}
