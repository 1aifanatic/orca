import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  isNativeChatEnabled,
  resolveStructuredNativeChatSupport
} from '../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceLaunchKind } from '../../../shared/workspace-launch-kind'
import type { NativeChatLaunchPromptDelivery } from '@/lib/native-chat-launch-prompt-delivery'

export { hasExplicitTuiLaunchCommand } from '../../../shared/tui-agent-launch-command-override'

export type AgentLaunchRoute = 'structured-native-chat' | 'terminal-tui'

export type AgentLaunchRoutingInput = {
  agent: TuiAgent
  settings: Pick<GlobalSettings, 'experimentalNativeChat'> | null | undefined
  executionHostId: string
  /** Capabilities of the target host; `null` = not yet established. */
  hostCapabilities: readonly string[] | null
  workspaceKind?: WorkspaceLaunchKind
  projectRuntime?: ProjectExecutionRuntimeResolution | null
  promptDelivery?: NativeChatLaunchPromptDelivery
  launchText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
  requiresTuiLaunchCommand?: boolean
  initialSessionOptions?: Readonly<Record<string, unknown>>
}

export function resolveAgentLaunchRoute(input: AgentLaunchRoutingInput): AgentLaunchRoute {
  return structuredAgentLaunchSupported(input) ? 'structured-native-chat' : 'terminal-tui'
}

// Explicit chat requests do not depend on the default view mode for new tabs.
export function structuredAgentLaunchSupported(
  input: Omit<AgentLaunchRoutingInput, 'launchText'>
): boolean {
  return (
    isNativeChatEnabled(input.settings) &&
    resolveStructuredNativeChatSupport({
      agent: input.agent,
      executionHostId: input.executionHostId,
      hostCapabilities: input.hostCapabilities,
      workspaceKind: input.workspaceKind,
      projectRuntime: input.projectRuntime,
      requiresTuiLaunchCommand: input.requiresTuiLaunchCommand
    }).supported
  )
}
