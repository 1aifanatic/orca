import {
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_FINAL_STATE_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { agentSessionSendSubmission } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from '../../../native-chat/agent-session-wire/structured-agent-session-send-settlement'
import type { RpcContext } from '../core'
import { requireStructuredHost, structuredCallerFor } from './structured-agent-session-gate'

/** Under the 15 s a released desktop gives a send to a remote host, with room for the request. */
export const ACCEPTED_SEND_CLIENT_HOLD_MS = 10_000

/**
 * A send answers once the host accepts it. A client that predates that answer cannot show a
 * message rejected after it, so its reply is held until the message is handed over or rejected —
 * or queued behind a running command such as `/compact`, which could outlast the client's own
 * request timeout; one that predates pending replies at all waits, as before, for the provider's
 * answer.
 *
 * Temporary: a desktop with only `accepted-send` reads `pending` as delivered, and a chat's first
 * message now starts its agent after that answer, so its reply waits past the start, up to
 * `holdMs`. A start still under way then is answered `unknown`, which that client reads as not
 * delivered and resends only under the same id, which the host answers from its ledger.
 */
export async function sendStructuredAgentSessionForClient(
  params: Parameters<StructuredAgentSessionHost['send']>[1],
  context: RpcContext,
  holdMs = ACCEPTED_SEND_CLIENT_HOLD_MS
) {
  const startedAt = Date.now()
  const host = requireStructuredHost(context)
  // Only a client's own send lifts a Stop's queue pause; host-internal senders never do.
  const result = await host.send(structuredCallerFor(context), { ...params, userSend: true })
  const capabilities = context.clientCapabilities ?? []
  if (
    !result.ok ||
    // A queued answer only ever reaches a capable client, which renders it as-is.
    agentSessionSendSubmission(result.value)?.dispatchState !== 'pending' ||
    context.clientKind === undefined ||
    capabilities.includes(AGENT_SESSION_SEND_FINAL_STATE_RUNTIME_CAPABILITY)
  ) {
    return result
  }
  const signal = context.signal ? { signal: context.signal } : {}
  if (capabilities.includes(AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY)) {
    const settled = await host.waitForSendSettlement(
      params.envelope.sessionId,
      result.value.clientMessageId,
      { until: 'past-start', budgetMs: Math.max(0, holdMs - (Date.now() - startedAt)), ...signal }
    )
    if (settled) {
      return { ...result, ...settled }
    }
    const submission = agentSessionSendSubmission(result.value)
    return submission
      ? {
          ...result,
          value: {
            ...result.value,
            submission: { ...submission, dispatchState: 'unknown' as const }
          }
        }
      : result
  }
  // The start that used to run before the reply now runs after acceptance, so both waits cover it.
  const settled = await host.waitForSendSettlement(
    params.envelope.sessionId,
    result.value.clientMessageId,
    {
      until: capabilities.includes(AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY)
        ? 'handed-over-or-behind-command'
        : 'answered',
      budgetMs: STRUCTURED_AGENT_SESSION_START_WAIT_MS,
      ...signal
    }
  )
  return settled ? { ...result, ...settled } : result
}
