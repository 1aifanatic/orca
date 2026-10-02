import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError,
  type AgentSessionCancelOutcome,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  answerCodexPrompt,
  prepareCodexPromptAnswer,
  type CodexPendingPrompt,
  type CodexPreparedAnswer
} from './codex-structured-prompt-replies'
import { requireLiveCodexSession, type CodexSession } from './codex-structured-session-state'
import { interruptCodexTurn } from './codex-structured-turn-cancellation'
import { codexStopTarget } from './codex-structured-turn-open-wait'

type CancelInput = Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0]
type AnswerInput = Parameters<StructuredAgentSessionAdapter['answerPrompt']>[0]

/** A command's Stop interrupts the provider turn carrying it; any other turn is its own. */
function providerTurnId(session: CodexSession, turnId: string): string | undefined {
  return session.translator ? session.translator.commandProviderTurnId(turnId) : turnId
}

/** A send whose answer this child lost: Codex may still open a turn for it that no Stop can name.
 *  A pending one Codex answered is not: its turn is the one the Stop waits for. */
function sendInDoubt(dispatchStatus: CancelInput['dispatchStatus']): boolean {
  return dispatchStatus?.state === 'unknown' && !dispatchStatus.recovered
}

/** The Stop's own answer, naming the journal turn it stopped when it took. */
function stoppedTurn(
  outcome: AgentSessionCancelOutcome,
  turnId: string
): AgentSessionCancelOutcome {
  return outcome.cancelled ? { ...outcome, turnId } : outcome
}

/**
 * A Stop that names no turn: interrupt the turn the journal shows, or else the one Codex reported
 * started and not yet ended, which the journal can trail by a publish, or else the one Codex
 * answered a send into, once it opens. A turn that may still open, unanswered or not open in time,
 * is one this Stop cannot reach: it answers refused, and the host ends the child.
 */
async function cancelCodexConversation(
  input: Parameters<typeof cancelCodexStructuredTurn>[0],
  session: CodexSession
): Promise<AgentSessionCancelOutcome> {
  const { request, sessions, requestTimeoutMs } = input
  const liveTurnId = request.resolveLiveTurnId?.() ?? null
  // A turn the journal shows that Codex has not started yet (a compaction's) has nothing to stop.
  const target = liveTurnId === null ? await codexStopTarget(session) : { turnId: liveTurnId }
  // The wait for the turn to open can outlive the session it began on.
  if (
    sessions.get(request.sessionId) !== session ||
    session.ended ||
    session.fence !== request.fence
  ) {
    return { cancelled: false }
  }
  if (target === null || 'opening' in target) {
    return target !== null || sendInDoubt(request.dispatchStatus)
      ? { cancelled: false, refusal: { turnMayOpen: true } }
      : { cancelled: false }
  }
  const turnId = liveTurnId === null ? target.turnId : providerTurnId(session, liveTurnId)
  if (!turnId) {
    return { cancelled: false }
  }
  return stoppedTurn(
    await interruptCodexTurn({ session, threadId: session.threadId, turnId, requestTimeoutMs }),
    target.turnId
  )
}

export async function cancelCodexStructuredTurn(input: {
  request: CancelInput
  sessions: Map<string, CodexSession>
  requestTimeoutMs?: number
}): Promise<AgentSessionCancelOutcome> {
  const { request, sessions, requestTimeoutMs } = input
  const session = requireLiveCodexSession(sessions, request.sessionId)
  const prompt = request.prompt
  const requestedTurnId = request.turnId
  if (requestedTurnId === undefined) {
    return prompt ? { cancelled: false } : cancelCodexConversation(input, session)
  }
  const turnId = providerTurnId(session, requestedTurnId)
  if (!turnId) {
    return { cancelled: false }
  }
  if (!prompt) {
    return stoppedTurn(
      await interruptCodexTurn({ session, threadId: session.threadId, turnId, requestTimeoutMs }),
      requestedTurnId
    )
  }
  if (session.fence !== request.fence) {
    return { cancelled: false }
  }
  const claim = session.prompts.claimBound(prompt.itemId)
  const promptTurnId = claim?.prompt.turnId
  if (!claim || !promptTurnId) {
    if (claim) {
      session.prompts.releaseClaim(claim)
    }
    return { cancelled: false }
  }
  let interruptConfirmed = false
  try {
    const result = await interruptCodexTurn({
      session,
      threadId: claim.prompt.threadId,
      turnId: promptTurnId,
      requestTimeoutMs,
      onConfirmed: () => {
        interruptConfirmed = true
        return session.translator?.cancelPrompt(prompt.itemId) ?? { accepted: true }
      }
    })
    if (!result.cancelled) {
      session.prompts.releaseClaim(claim)
    }
    return result
  } catch (error) {
    if (!interruptConfirmed) {
      session.prompts.releaseClaim(claim)
    }
    throw error
  }
}

function prepareCodexAnswer(
  prompt: CodexPendingPrompt,
  response: AnswerInput['response']
): CodexPreparedAnswer {
  try {
    return prepareCodexPromptAnswer(prompt, response)
  } catch (error) {
    throw new AgentSessionPromptAnswerRejectedError(
      error instanceof Error ? error.message : String(error)
    )
  }
}

export async function answerCodexStructuredPrompt(input: {
  request: AnswerInput
  sessions: Map<string, CodexSession>
}): Promise<void> {
  const { request, sessions } = input
  const session = sessions.get(request.sessionId)
  if (!session || session.ended || session.fence !== request.fence) {
    throw new AgentSessionPromptUnavailableError(request.itemId)
  }
  const acquisitionGeneration = session.acquisitionGeneration
  const claim = session.prompts.claim(request.itemId, request.kind)
  if (!claim) {
    throw new AgentSessionPromptUnavailableError(request.itemId)
  }
  try {
    const prepared = prepareCodexAnswer(claim.prompt, request.response)
    await request.commit()
    if (
      sessions.get(request.sessionId) !== session ||
      session.ended ||
      session.fence !== request.fence ||
      session.acquisitionGeneration !== acquisitionGeneration ||
      !session.prompts.ownsClaim(claim)
    ) {
      throw new AgentSessionPromptUnavailableError(request.itemId)
    }
    session.translator?.resolvePrompt(request.itemId)
    answerCodexPrompt(session.prompts, session.connection, claim, prepared)
  } catch (error) {
    session.prompts.releaseClaim(claim)
    throw error
  }
}
