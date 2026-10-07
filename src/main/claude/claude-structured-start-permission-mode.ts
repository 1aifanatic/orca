import { agentChatLaunchPermissionMode } from '../../shared/agent-chat-permission-mode'
import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'
import { readClaudeModels } from './claude-structured-init-proof'
import { listedModels, matchListedModel } from './claude-structured-model-catalog'
import { claudeSdkPermissionMode } from './claude-structured-permission-mode'
import type { ClaudeSession } from './claude-structured-session-state'
import type { ClaudeStartupFacts } from './claude-structured-session-startup'

export function claudeDefaultPermissionNeedsStartup(
  session: Pick<ClaudeSession, 'options' | 'launchPermissionMode'>
): boolean {
  return (
    !session.options.has('permissionMode') &&
    (session.launchPermissionMode === 'accept-edits' || session.launchPermissionMode === 'auto')
  )
}

export async function applyClaudeStartPermissionMode(
  session: ClaudeSession,
  facts: ClaudeStartupFacts
): Promise<void> {
  if (!claudeDefaultPermissionNeedsStartup(session)) {
    return
  }
  const models = listedModels({ models: readClaudeModels(facts.initialization) })
  const model = session.options.get('model') ?? session.reportedOptions.model ?? 'default'
  const autoReview = matchListedModel(models, model)?.supportsAutoMode === true
  let mode = agentChatLaunchPermissionMode('claude', null, session.launchPermissionMode, {
    autoReview
  })
  try {
    await session.connection.setPermissionMode(claudeSdkPermissionMode(mode), {
      timeoutMs: facts.requestTimeoutMs
    })
  } catch (error) {
    if (!(error instanceof ClaudeControlRequestError)) {
      throw error
    }
    mode = 'ask'
    await session.connection.setPermissionMode('default', { timeoutMs: facts.requestTimeoutMs })
  }
  session.options.set('permissionMode', mode)
  session.confirmedOptions.add('permissionMode')
}
