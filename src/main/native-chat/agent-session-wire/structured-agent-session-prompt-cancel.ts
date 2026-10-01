// A prompt card's own controls, routed the way its provider says. Its Cancel goes to one of the
// approval's options, sent as if the user picked it, or to the chat's Stop; an option can be the
// chat's Stop too. A provider that says nothing keeps the old routes. The host decides, so a client
// of any version gets the same card.

import type {
  AgentSessionCancelResult,
  AgentSessionPromptResult
} from '../../../shared/agent-session-wire'
import { validatePendingPrompt } from './structured-agent-session-prompt-state'
import {
  performPrompt,
  type AgentSessionPromptRequest
} from './structured-agent-session-turns-prompt'
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
  const answer = ctx.adapter.routePromptAnswer?.(ctx.sessionId, validated.prompt.kind)
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

/** A card's option, unless its provider routes that option to the chat's Stop. */
export async function answerStructuredAgentSessionPromptOrStop(
  ctx: AgentSessionTurnContext,
  input: AgentSessionPromptRequest,
  routes: {
    stop: () => Promise<CancelOutcome>
    answer: () => Promise<TurnOutcome<AgentSessionPromptResult>>
  }
): Promise<TurnOutcome<AgentSessionPromptResult>> {
  const route =
    input.optionId === undefined
      ? undefined
      : ctx.adapter.routePromptAnswer?.(ctx.sessionId, input.kind, input.optionId)
  if (route?.kind !== 'stop') {
    return routes.answer()
  }
  const validated = validatePendingPrompt(ctx, input)
  if (!validated.ok) {
    return validated
  }
  const stopped = await routes.stop()
  if (!stopped.ok) {
    return stopped
  }
  // The card settles as the Stop ends what asked it; the answer reports it as it reads now.
  const item = ctx.journal.snapshot().items.find((entry) => entry.itemId === input.itemId)
  const body = item?.body
  return item && body && (body.kind === 'approval' || body.kind === 'question')
    ? {
        ok: true,
        value: { itemId: item.itemId, revision: item.revision, resolution: body.resolution }
      }
    : {
        ok: true,
        value: {
          itemId: input.itemId,
          revision: validated.item.revision,
          resolution: validated.prompt.resolution
        }
      }
}
