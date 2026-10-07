import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModes,
  agentChatPermissionModeSupported,
  type AgentChatPermissionMode,
  type AgentSessionPermissionModes
} from '../../shared/agent-chat-permission-mode'
import { codexStructuredPermissionPolicy } from './codex-structured-permission-policy'

/** What a Codex chat's mode is read from: its pick, and what its thread runs. */
export type CodexPermissionModeState = {
  options: ReadonlyMap<string, string>
  threadPermissionMode?: AgentChatPermissionMode
  approvalsReviewerSupported?: boolean
}

function reviewerSupport(state: CodexPermissionModeState): { autoReview: boolean } {
  return { autoReview: state.approvalsReviewerSupported === true }
}

/** The mode the chat's next turn runs: its pick, else its thread's. Approve for me on an
 *  app-server with no reviewer routing runs as Ask, so it reads as Ask. */
export function codexChatPermissionMode(state: CodexPermissionModeState): AgentChatPermissionMode {
  const picked = state.options.get(AGENT_CHAT_PERMISSION_MODE_OPTION_ID)
  const mode = agentChatPermissionModeSupported('codex', picked)
    ? picked
    : (state.threadPermissionMode ?? 'ask')
  return mode === 'auto' && !reviewerSupport(state).autoReview ? 'ask' : mode
}

export function codexPermissionModesFor(
  state: CodexPermissionModeState
): AgentSessionPermissionModes {
  return {
    current: codexChatPermissionMode(state),
    supported: agentChatPermissionModes('codex', reviewerSupport(state)) ?? []
  }
}

/** Whether a pick is one this session's app-server can run. */
export function codexPermissionModePickable(
  state: CodexPermissionModeState,
  value: string
): value is AgentChatPermissionMode {
  return agentChatPermissionModeSupported('codex', value, reviewerSupport(state))
}

/**
 * The `turn/start` fields that move the thread to the chat's mode, or null when it already runs
 * it. Codex applies them to this turn and every later one, so they are sent only on a change: an
 * unchanged turn leaves the thread's config-merged sandbox alone. The sandbox is restated only
 * when it changes, because the turn form replaces the whole policy with its defaults.
 */
export function codexTurnPermissionOverrides(
  state: CodexPermissionModeState
): { mode: AgentChatPermissionMode; params: Record<string, unknown> } | null {
  // With no pick, the thread runs what it opened with: the setting's mode, stated at open.
  if (
    !agentChatPermissionModeSupported(
      'codex',
      state.options.get(AGENT_CHAT_PERMISSION_MODE_OPTION_ID)
    )
  ) {
    return null
  }
  const mode = codexChatPermissionMode(state)
  const thread = state.threadPermissionMode
  if (mode === thread) {
    return null
  }
  const policy = codexStructuredPermissionPolicy(mode)
  const sandboxChanged = thread === undefined || (thread === 'bypass') !== (mode === 'bypass')
  return {
    mode,
    params: {
      approvalPolicy: policy.approvalPolicy,
      ...('approvalsReviewer' in policy && reviewerSupport(state).autoReview
        ? { approvalsReviewer: policy.approvalsReviewer }
        : {}),
      ...(sandboxChanged
        ? {
            sandboxPolicy:
              policy.sandbox === 'danger-full-access'
                ? { type: 'dangerFullAccess' }
                : { type: 'workspaceWrite' }
          }
        : {})
    }
  }
}
