// A chat's saved model is passed to the CLI as `--model` unchecked, so one the provider has since
// retired fails the turn. The CLI says so itself: a synthetic reply whose `error` is
// `model_not_found` (Claude Code 2.1.280). That reply is the evidence the saved model cannot run.

import type { AgentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { ClaudeSession } from './claude-structured-session-state'

/** True once, when a root reply says the model this child was launched with does not exist and
 *  the chat still has that model picked: the session stops holding it, so the record drops it. */
export function retireClaudeLaunchedModel(
  session: Pick<ClaudeSession, 'launchedModel' | 'options' | 'restoreSkippedOptions'>,
  message: Record<string, unknown>
): boolean {
  const launched = session.launchedModel
  if (
    launched === null ||
    message.type !== 'assistant' ||
    (message.parent_tool_use_id ?? null) !== null ||
    message.error !== 'model_not_found' ||
    session.options.get('model') !== launched
  ) {
    return false
  }
  session.options.delete('model')
  session.restoreSkippedOptions.add('model')
  return true
}

/** The rows of a listing the account's catalog keeps. A child launched with `--model X` lists X
 *  itself (Claude Code 2.1.280 adds a row named by the raw id, "Custom model"), whether or not X
 *  exists: that row is the launch talking, not the account, unless the account already listed X.
 *  Native rows carry a display name of their own, so a row named by its id is the tell. */
export function claudeCatalogRowsOfAccount<T extends { id: string; label: string }>(
  access: AgentModelCatalogSessionAccess,
  rows: readonly T[],
  launchedModel: string | null
): T[] {
  const listedBefore = access.store
    .get(access.fingerprint)
    ?.models.some((model) => model.id === launchedModel)
  return rows.filter(
    (row) => listedBefore === true || row.id !== launchedModel || row.label !== row.id
  )
}
