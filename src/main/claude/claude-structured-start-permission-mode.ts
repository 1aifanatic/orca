import { agentChatLaunchPermissionMode } from '../../shared/agent-chat-permission-mode'
import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'
import { readClaudeModels } from './claude-structured-init-proof'
import { listedModels, matchListedModel } from './claude-structured-model-catalog'
import {
  applyClaudePermissionMode,
  claudePermissionNeedsPreparation
} from './claude-structured-permission-application'
import { claudeSdkPermissionMode } from './claude-structured-permission-mode'
import type { ClaudeSession } from './claude-structured-session-state'
import type { ClaudeStartupFacts } from './claude-structured-session-startup'

export async function applyClaudeStartPermissionMode(
  session: ClaudeSession,
  facts: ClaudeStartupFacts
): Promise<void> {
  if (!claudePermissionNeedsPreparation(session)) {
    return
  }
  const models = listedModels({ models: readClaudeModels(facts.initialization) })
  const model = session.options.get('model') ?? session.reportedOptions.model ?? 'default'
  const autoReview = matchListedModel(models, model)?.supportsAutoMode === true
  let mode = agentChatLaunchPermissionMode(
    'claude',
    Object.fromEntries(session.options),
    session.launchPermissionMode,
    {
      autoReview
    }
  )
  try {
    await applyClaudePermissionMode(session, claudeSdkPermissionMode(mode), facts.requestTimeoutMs)
  } catch (error) {
    if (!(error instanceof ClaudeControlRequestError)) {
      throw error
    }
    mode = 'ask'
    await applyClaudePermissionMode(session, 'default', facts.requestTimeoutMs)
  }
  session.options.set('permissionMode', mode)
  session.confirmedOptions.add('permissionMode')
}
