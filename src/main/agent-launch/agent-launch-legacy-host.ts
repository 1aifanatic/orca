/**
 * The executor's half of the `legacy-host` prompt policy: `worktree.create`'s own startup contract,
 * kept for the host's legacy producers until one planner replaces both policies.
 *
 * The create owns the text, so the executor hands it the whole prompt instead of an argv offer and
 * delivers nothing itself; and the create's startup terminal is the launch's only surface.
 */

import type {
  AgentLaunchPrompt,
  AgentLaunchPromptDisposal,
  AgentLaunchResult
} from '../../shared/agent-launch-intent'
import type { AgentLaunchExecution } from './agent-launch-executor'
import type { AgentLaunchModeReceipt } from './agent-launch-mode'
import {
  HANDED_TO_TERMINAL,
  launchCommandPrompt,
  promptReceipt
} from './agent-launch-prompt-delivery'
import { AgentLaunchStartupAgentNotCreatedError } from './agent-launch-surface-factories'

const LEGACY_HOST_REQUIRES_TERMINAL_CREATE =
  'agent_launch_legacy_prompt_policy_requires_terminal_create'

/** What a create is handed to deliver: the launch's argv offer, or under this policy all of it. */
export function createLaunchPromptInputs(
  execution: Pick<AgentLaunchExecution, 'intent' | 'promptPolicy' | 'terminalOnly'>,
  mode: AgentLaunchModeReceipt['mode']
): { startupPrompt?: string; legacyPrompt?: AgentLaunchPrompt } {
  if (execution.promptPolicy !== 'legacy-host') {
    const startupPrompt = launchCommandPrompt(execution.intent, mode)
    return startupPrompt ? { startupPrompt } : {}
  }
  // Only a terminal create has the startup terminal this policy hands the text to.
  if (!execution.terminalOnly) {
    throw new Error(LEGACY_HOST_REQUIRES_TERMINAL_CREATE)
  }
  return execution.intent.prompt ? { legacyPrompt: execution.intent.prompt } : {}
}

/** The launch once the create returned; see `AgentLaunchStartupAgentNotCreatedError` for none. */
export function legacyHostCreateResult(
  execution: Pick<AgentLaunchExecution, 'intent'>,
  placed: {
    worktreeId: string
    startupTerminalHandle: string | undefined
    startupTerminalPaneKey?: string
    warning?: string
  },
  receipt: AgentLaunchModeReceipt
): AgentLaunchResult {
  if (execution.intent.target.kind !== 'create-worktree') {
    throw new Error(LEGACY_HOST_REQUIRES_TERMINAL_CREATE)
  }
  if (!placed.startupTerminalHandle) {
    throw new AgentLaunchStartupAgentNotCreatedError(placed.worktreeId)
  }
  return {
    outcome: {
      kind: 'terminal',
      handle: placed.startupTerminalHandle,
      ...(placed.startupTerminalPaneKey ? { paneKey: placed.startupTerminalPaneKey } : {})
    },
    worktreeId: placed.worktreeId,
    receipt,
    ...(placed.warning ? { warning: placed.warning } : {}),
    ...promptReceipt(execution.intent, legacyCreatePromptDisposal(execution.intent.prompt))
  }
}

/**
 * The create folds a submit into the command or writes it once the agent is up; either way the host
 * owns it now and a resend would arrive as a second turn. A draft is unsent text the host never
 * vouches for.
 */
function legacyCreatePromptDisposal(
  prompt: AgentLaunchPrompt | undefined
): AgentLaunchPromptDisposal {
  return prompt?.delivery === 'submit' ? HANDED_TO_TERMINAL : { outcome: 'not-delivered' }
}
