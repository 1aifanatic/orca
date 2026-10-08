// A saved Fast the Claude child was launched without, applied once its start has read the settings
// that decide whether it may run.

import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'
import { readClaudeModels } from './claude-structured-init-proof'
import { listedModels } from './claude-structured-model-catalog'
import { claudeModelFastModeSupport } from './claude-structured-session-options'
import type { ClaudeStartupFacts, ClaudeStartupReport } from './claude-structured-session-startup'
import type { ClaudeSession } from './claude-structured-session-state'

/** A saved Fast on that a new conversation's launch left out (`fastModeAtStart`), since its settings
 *  may opt in to it per session. Those settings now read: that opt-in drops it, as before, and so
 *  do the guards a live Fast write takes. Whether Fast on is still to be applied. */
export function admitClaudeStartFastMode(
  session: ClaudeSession,
  facts: ClaudeStartupFacts
): boolean {
  if (!session.fastModeAtStart || session.options.get('fastMode') === undefined) {
    return false
  }
  if (facts.prepared.fastModePerSessionOptIn === true) {
    session.options.delete('fastMode')
    return false
  }
  // Over the listing this start already holds.
  const listed = listedModels({ models: readClaudeModels(facts.initialization) })
  const blocked =
    session.fastModeDisabledReason !== undefined &&
    !['preference', 'sdk_opt_in_required'].includes(session.fastModeDisabledReason)
  if (
    blocked ||
    (listed.length > 0 && claudeModelFastModeSupport(session, listed).supported !== true)
  ) {
    session.options.delete('fastMode')
    session.restoreSkippedOptions.add('fastMode')
    return false
  }
  return true
}

/** Applies the saved Fast on the launch left out after `started`, so nothing waits on it. A refusal
 *  drops it as main's refused restore did, from the record too; silence keeps it wanted and
 *  unconfirmed. A write the user made meanwhile owns the option. */
export async function applyClaudeStartFastMode(
  session: ClaudeSession,
  facts: ClaudeStartupFacts,
  report: (event: ClaudeStartupReport) => void
): Promise<void> {
  const sequence = session.optionMutationSequence
  try {
    await session.connection.applyFlagSettings(
      { fastMode: true },
      { timeoutMs: facts.requestTimeoutMs }
    )
  } catch (error) {
    if (sequence !== session.optionMutationSequence) {
      return
    }
    session.confirmedOptions.delete('fastMode')
    if (error instanceof ClaudeControlRequestError) {
      session.options.delete('fastMode')
      session.restoreSkippedOptions.add('fastMode')
      report({ type: 'options-skipped', options: { fastMode: 'true' } })
    }
  }
}
