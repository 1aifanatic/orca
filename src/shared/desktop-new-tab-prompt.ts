import type { AgentLaunchPrompt, AgentLaunchPromptDelivery } from './agent-launch-intent'
import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

export type DesktopNewTabPromptTransport = {
  kind: 'desktop-new-tab'
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
}

export type DesktopNewTabPrompt = AgentLaunchPrompt & {
  transport: DesktopNewTabPromptTransport
}

export function isDesktopNewTabPrompt(
  prompt: AgentLaunchPrompt | undefined
): prompt is DesktopNewTabPrompt {
  return typeof prompt?.transport === 'object' && prompt.transport.kind === 'desktop-new-tab'
}

export function desktopNewTabPromptDelivery(
  agent: TuiAgent,
  mode: DesktopNewTabPromptTransport['promptDelivery']
): AgentLaunchPromptDelivery {
  return mode === 'draft' ||
    (mode === 'auto-submit' && TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start')
    ? 'draft'
    : 'submit'
}
