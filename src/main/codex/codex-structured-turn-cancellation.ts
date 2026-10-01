import { isCodexAppServerRequestError } from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import { providerDiagnosticOf } from '../../shared/agent-session-failure'
import type { AgentSessionCancelOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CodexSession } from './codex-structured-session-state'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-contracts'

/**
 * Codex refuses an interrupt as an invalid request (-32600) only when the named turn is not its
 * active one: no turn running, another turn running, or the thread not loaded. Its other refusal,
 * an internal error (-32603), is an interrupt it could not submit, with the turn still running.
 */
function isCodexTurnNotRunningRefusal(error: unknown): boolean {
  return isCodexAppServerRequestError(error) && error.code === -32600
}

/**
 * Codex answers a turn's interrupt only as that turn ends, so the answer is what confirms the
 * Stop. An answered interrupt is the whole Stop: Codex kills the turn's one-shot commands itself
 * and keeps its background terminals running until the thread ends. One Codex could not carry out,
 * or never answered, leaves the host to end the child (`performCancel`).
 */
export async function interruptCodexTurn(input: {
  session: CodexSession
  threadId: string
  turnId: string
  requestTimeoutMs?: number
  onConfirmed?: () => CodexJournalTranslationAdmission
}): Promise<AgentSessionCancelOutcome> {
  const { session, threadId, turnId } = input
  try {
    await session.connection.request(
      'turn/interrupt',
      { threadId, turnId },
      { timeoutMs: input.requestTimeoutMs }
    )
  } catch (error) {
    if (!isCodexAppServerRequestError(error) && !isCodexAppServerUnsupportedError(error)) {
      throw error
    }
    const detail = providerDiagnosticOf(error)
    return {
      cancelled: false,
      refusal: {
        ...(detail ? { detail } : {}),
        ...(isCodexTurnNotRunningRefusal(error) ? { turnNotRunning: true } : {})
      }
    }
  }
  const promptAdmission = input.onConfirmed?.()
  if (promptAdmission && !promptAdmission.accepted) {
    throw new Error(
      `Codex prompt cancellation lifecycle was not admitted (${promptAdmission.reason})`
    )
  }
  return { cancelled: true }
}
