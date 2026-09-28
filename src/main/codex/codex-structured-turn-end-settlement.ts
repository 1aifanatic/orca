// A send Codex answered into a turn that then ended without echoing it. Codex clears
// a turn's pending input when it is interrupted, so that send never reached the model
// and is withdrawn, as a Stop's host-side withdrawal is. A turn that failed before
// taking it is a send Codex refused, in its own words. A completed turn records
// pending input as it finishes, so its sends' echoes are still due and it settles
// nothing.

import {
  agentSessionFailureFact,
  providerDiagnostic,
  type ProviderDiagnostic,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection
} from '../../shared/agent-session-failure-words'
import type { CodexTurnEnd } from './codex-structured-dispatch-echo'
import { readCodexProviderVerdict } from './codex-structured-journal-provider-verdicts'
import type { CodexSession } from './codex-structured-session-state'
import {
  readCodexThreadId,
  readCodexTurnId,
  readCodexTurnStatus
} from './codex-structured-thread-facts'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'

/** A message Codex rejected, in the words that name Codex and its legacy markers. */
export function codexDispatchRejection(
  failure: SubmissionRejectionFact
): AgentJournalDispatchRejection {
  return agentSessionFailureWords(failure, {
    surface: 'rejection',
    agentName: TUI_AGENT_DISPLAY_NAMES.codex,
    provider: 'codex'
  })
}

export type CodexTurnEndSettlement = {
  clientMessageId: string
  state: 'rejected'
} & AgentJournalDispatchRejection

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Reflect.get(value, key)
    : undefined
}

function errorDetail(error: unknown): ProviderDiagnostic | undefined {
  const message = field(error, 'message')
  return typeof message === 'string' ? providerDiagnostic(message, 'person') : undefined
}

/** The end a primary-thread notification reports for its turn, or null for any other frame. */
export function readCodexTurnEnd(method: string, params: unknown): CodexTurnEnd | null {
  if (method === 'turn/completed') {
    const status = readCodexTurnStatus(params)
    if (status === 'interrupted') {
      return { status: 'interrupted' }
    }
    if (status === 'failed') {
      const detail = errorDetail(field(field(params, 'turn'), 'error'))
      return { status: 'failed', ...(detail ? { detail } : {}) }
    }
    return { status: 'completed' }
  }
  if (readCodexProviderVerdict(method, params) === 'turn-failed') {
    const detail = errorDetail(field(params, 'error'))
    return { status: 'failed', ...(detail ? { detail } : {}) }
  }
  return null
}

/** How an ended turn settles a send it never echoed; null leaves the send to its echo. */
export function codexTurnEndRejection(end: CodexTurnEnd): AgentJournalDispatchRejection | null {
  if (end.status === 'interrupted') {
    return agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
  }
  if (end.status === 'failed') {
    return codexDispatchRejection(
      agentSessionFailureFact('providerRejected', end.detail ? { detail: end.detail } : {})
    )
  }
  return null
}

/** Settles the sends bound to the turn this admitted notification ended. */
export function settleCodexSendsInEndedTurn(
  session: Pick<CodexSession, 'threadId' | 'dispatchEchoes'>,
  method: string,
  params: unknown,
  settle: (settlement: CodexTurnEndSettlement) => void
): void {
  const turnId = readCodexTurnId(params)
  const end = readCodexTurnEnd(method, params)
  if (!turnId || !end || (readCodexThreadId(params) ?? session.threadId) !== session.threadId) {
    return
  }
  const rejection = codexTurnEndRejection(end)
  for (const clientMessageId of session.dispatchEchoes.endTurn(session.threadId, turnId, end)) {
    if (rejection) {
      settle({ clientMessageId, state: 'rejected', ...rejection })
    }
  }
}
