import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'
import {
  claudeChatPermissionMode,
  claudeSdkPermissionMode
} from './claude-structured-permission-mode'
import type { ClaudeSession } from './claude-structured-session-state'
import { isAgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'

export function claudePermissionNeedsPreparation(
  session: Pick<ClaudeSession, 'options' | 'launchPermissionMode' | 'appliedPermissionMode'>
): boolean {
  return session.appliedPermissionMode !== claudeChatPermissionMode(session)
}

/** A lost answer cannot vouch for the policy that still runs. */
export async function applyClaudePermissionMode(
  session: ClaudeSession,
  mode: PermissionMode,
  timeoutMs: number | undefined
): Promise<void> {
  const previous = session.appliedPermissionMode
  const mutation = session.optionMutationSequence
  delete session.appliedPermissionMode
  try {
    await session.connection.setPermissionMode(mode, { timeoutMs })
    if (mutation === session.optionMutationSequence) {
      const applied =
        mode === 'default'
          ? 'ask'
          : mode === 'acceptEdits'
            ? 'accept-edits'
            : mode === 'bypassPermissions'
              ? 'bypass'
              : mode
      if (isAgentChatPermissionMode(applied)) {
        session.appliedPermissionMode = applied
      }
    }
  } catch (error) {
    if (error instanceof ClaudeControlRequestError && mutation === session.optionMutationSequence) {
      session.appliedPermissionMode = previous
    }
    throw error
  }
}

/** Runs outside the mutation lane so Stop can cancel startup or reconciliation. */
export function prepareClaudePermissionMode(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<void> | undefined {
  if (!claudePermissionNeedsPreparation(session)) {
    return undefined
  }
  const ready = session.startup.state === 'pending' ? session.startup.settled : Promise.resolve()
  return ready.then(async () => {
    if (session.startup.state !== 'proven') {
      throw session.startup.failure ?? new Error('claude startup did not complete')
    }
    while (claudePermissionNeedsPreparation(session)) {
      await applyClaudePermissionMode(
        session,
        claudeSdkPermissionMode(claudeChatPermissionMode(session)),
        timeoutMs
      )
    }
  })
}
