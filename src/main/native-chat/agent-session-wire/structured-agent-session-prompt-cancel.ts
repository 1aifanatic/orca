// A prompt card's own Cancel, answered the way its provider says: one of the approval's options,
// sent as if the user picked it, or the chat's Stop. A provider that says nothing interrupts the
// turn holding the card. The host decides, so a client of any version gets the same Cancel.

import type { AgentSessionCancelResult } from '../../../shared/agent-session-wire'
import { validatePendingPrompt } from './structured-agent-session-prompt-state'
import { performPrompt } from './structured-agent-session-turns-prompt'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

type CancelOutcome = TurnOutcome<AgentSessionCancelResult>

export async function cancelStructuredAgentSessionPrompt(
  ctx: AgentSessionTurnContext,
  input: { turnId?: string; prompt: { itemId: string; expectedRevision: number } },
  routes: { stop: () => Promise<CancelOutcome>; interrupt: () => Promise<CancelOutcome> }
): Promise<CancelOutcome> {
  const validated = validatePendingPrompt(ctx, input.prompt)
  if (!validated.ok) {
    return validated
  }
  const answer = ctx.adapter.promptCancelAnswer?.(ctx.sessionId, validated.prompt.kind)
  if (!answer) {
    return routes.interrupt()
  }
  if (answer.kind === 'stop') {
    return routes.stop()
  }
  const answered = await performPrompt(ctx, {
    ...input.prompt,
    kind: validated.prompt.kind,
    optionId: answer.optionId
  })
  if (!answered.ok) {
    return answered
  }
  return { ok: true, value: { ...(input.turnId ? { turnId: input.turnId } : {}), cancelled: true } }
}
