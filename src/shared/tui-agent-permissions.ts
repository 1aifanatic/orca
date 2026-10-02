import { TUI_AGENT_CONFIG, isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

/** Whether Orca launches an agent with its permission-bypass flag (`bypass`, shown as Yolo) or without it (`ask`). */
export type AgentPermissionMode = 'bypass' | 'ask'

/** What an untouched profile gets; Orca has shipped agents in Yolo by default. */
export const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = 'bypass'

export const YOLO_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = {
  claude: '--dangerously-skip-permissions',
  codebuddy: '--dangerously-skip-permissions',
  'claude-agent-teams': '--dangerously-skip-permissions',
  openclaude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  qoder: '--dangerously-skip-permissions',
  gemini: '--yolo',
  antigravity: '--dangerously-skip-permissions',
  aider: '--yes-always',
  amp: '--dangerously-allow-all',
  kiro: '--trust-all-tools',
  crush: '--yolo',
  autohand: '--unrestricted',
  cline: '--auto-approve true',
  'command-code': '--yolo',
  continue: '--allow "*"',
  cursor: '--yolo',
  kimi: '--yolo',
  muse: '--yolo',
  // Why: ZCode gates tools by collaboration mode; `yolo` is its bypass-everything mode.
  zcode: '--mode yolo',
  'mistral-vibe': '--agent auto-approve',
  'qwen-code': '--approval-mode yolo',
  rovo: '--yolo',
  hermes: '--yolo',
  copilot: '--yolo',
  grok: '--permission-mode bypassPermissions',
  devin: '--permission-mode bypass --respect-workspace-trust false',
  ante: '--yolo',
  trae: '--yolo',
  droid: '--auto high'
}

export const YOLO_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> = {
  goose: { GOOSE_MODE: 'auto' }
}

export const PERMISSION_AGENT_IDS: readonly TuiAgent[] = Object.keys(TUI_AGENT_CONFIG).filter(
  (agent): agent is TuiAgent => agent in YOLO_TUI_AGENT_ARGS || agent in YOLO_TUI_AGENT_ENV
)

/**
 * Option names that change an agent's permission posture, beyond the first word of its bypass
 * flag. Used only to warn in Settings when free-text Arguments carry one.
 */
const EXTRA_PERMISSION_OPTION_NAMES: Partial<Record<TuiAgent, readonly string[]>> = {
  claude: ['--permission-mode', '--allow-dangerously-skip-permissions'],
  'claude-agent-teams': ['--permission-mode', '--allow-dangerously-skip-permissions'],
  openclaude: ['--permission-mode', '--allow-dangerously-skip-permissions'],
  codex: ['--yolo', '--ask-for-approval', '-a', '--sandbox', '-s', '--full-auto']
}

/** The persisted permission settings; part of GlobalSettings. */
export type AgentPermissionSettingsFields = {
  /** Mode every agent launches with unless it has its own override. Absent only on profiles saved
   *  before the mode was typed, which is what the load-time migration keys on. */
  agentPermissionMode?: AgentPermissionMode
  /** Agents whose permission mode differs from `agentPermissionMode`. */
  agentPermissionModeOverrides?: Partial<Record<TuiAgent, AgentPermissionMode>>
}

export function isAgentPermissionMode(value: unknown): value is AgentPermissionMode {
  return value === 'bypass' || value === 'ask'
}

export function agentHasPermissionMode(agent: TuiAgent): boolean {
  return agent in YOLO_TUI_AGENT_ARGS || agent in YOLO_TUI_AGENT_ENV
}

export function normalizeAgentPermissionModeOverrides(
  value: unknown
): Partial<Record<TuiAgent, AgentPermissionMode>> {
  const normalized: Partial<Record<TuiAgent, AgentPermissionMode>> = {}
  if (!value || typeof value !== 'object') {
    return normalized
  }
  for (const [agent, mode] of Object.entries(value)) {
    if (isTuiAgent(agent) && isAgentPermissionMode(mode)) {
      normalized[agent] = mode
    }
  }
  return normalized
}

/** The mode every agent without its own choice launches with. */
export function resolveDefaultAgentPermissionMode(
  settings: AgentPermissionSettingsFields | null | undefined
): AgentPermissionMode {
  return isAgentPermissionMode(settings?.agentPermissionMode)
    ? settings.agentPermissionMode
    : DEFAULT_AGENT_PERMISSION_MODE
}

/** The agent's own choice if it has one, else the default every agent shares. */
export function resolveAgentPermissionMode(
  agent: TuiAgent,
  settings: AgentPermissionSettingsFields | null | undefined
): AgentPermissionMode {
  const override = settings?.agentPermissionModeOverrides?.[agent]
  return isAgentPermissionMode(override) ? override : resolveDefaultAgentPermissionMode(settings)
}

/** The Settings switch: one mode for every agent, replacing any per-agent choice. */
export function applyAgentPermissionModeToAll(
  mode: AgentPermissionMode
): Required<AgentPermissionSettingsFields> {
  return { agentPermissionMode: mode, agentPermissionModeOverrides: {} }
}

/** Option names in this agent's arguments that change its permission posture, in order. */
export function agentPermissionOptionNames(agent: TuiAgent): readonly string[] {
  const bypassName = YOLO_TUI_AGENT_ARGS[agent]?.split(/\s+/)[0]
  const extra = EXTRA_PERMISSION_OPTION_NAMES[agent] ?? []
  return bypassName && !extra.includes(bypassName) ? [bypassName, ...extra] : extra
}
