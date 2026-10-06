// One `agentSession.send` attempt and what its answer proves. Everything before the request is
// local or read-only, so an attempt stopped there never went out.

import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import { structuredAgentSessionMessageSendMutation } from '../../../../shared/structured-agent-session-send-mutation'
import {
  structuredAgentSessionSendEvidence,
  type StructuredAgentSessionSendAnswer,
  type StructuredAgentSessionSendEvidence
} from '../../../../shared/structured-agent-session-send-evidence'
import { AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  ensureRuntimeEnvironmentCompatible,
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import {
  agentSessionThrownFailure,
  readAgentSessionErrorRefusal,
  type AgentSessionWriteFailure
} from '../../../../shared/agent-session-write-failure'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from '@/runtime/local-runtime-capabilities'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

const fences = new Map<string, number>()

/** The fence the session's host serves, as its subscription or launch receipt last reported. */
export function noteStructuredAgentSessionFence(sessionId: string, fence: number | null): void {
  if (fence !== null) {
    fences.set(sessionId, fence)
  }
}

export function forgetStructuredAgentSessionFence(sessionId: string): void {
  fences.delete(sessionId)
}

export function resetStructuredAgentSessionFencesForTests(): void {
  fences.clear()
}

/** Whether a refusal the host returns for a resent id proves it holds no such message. A failed
 *  probe reads as an older host, whose refusals prove nothing after a first attempt. */
async function hostAnswersWithProof(target: RuntimeClientTarget): Promise<boolean> {
  try {
    if (target.kind === 'environment') {
      return await runtimeEnvironmentSupportsCapability(
        target.environmentId,
        AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY
      )
    }
    const capabilities =
      readLocalRuntimeCapabilitiesOrUnknown() ?? (await ensureLocalRuntimeCapabilities())
    return capabilities?.includes(AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY) === true
  } catch {
    return false
  }
}

async function knownFence(target: RuntimeClientTarget, sessionId: string): Promise<number> {
  const known = fences.get(sessionId)
  if (known !== undefined) {
    return known
  }
  // Current hosts ignore it; an older host checks it, so read the one it serves now.
  const history = await callStructuredAgentSession<AgentSessionHistoryResult>(
    target,
    'agentSession.history',
    { sessionId, direction: 'tail', limit: 1 }
  )
  const fence = history.page.fence ?? (!history.ok ? history.fence : undefined)
  if (typeof fence !== 'number') {
    throw new Error('structured session fence unavailable')
  }
  fences.set(sessionId, fence)
  return fence
}

export type StructuredAgentSessionSendAttempt = {
  evidence: StructuredAgentSessionSendEvidence
  /** The host's row, when its answer carried one. */
  submission: AgentJournalSubmission | null
  /** The refusal a thrown answer carried: what the host said, though it proves nothing. */
  thrownRefusal: AgentSessionWriteFailure | null
  /** A definite failure before this request went out, which trying again won't clear: the host
   *  refused the checks, or this client and the server can't talk. Null for a transport error. */
  blocked: { failure: AgentSessionWriteFailure } | { text: string } | null
}

function blockedBeforeRequest(
  error: unknown,
  rpcCode: string | undefined
): StructuredAgentSessionSendAttempt['blocked'] {
  if (isRuntimeCompatBlockError(error) && error instanceof Error) {
    return { text: error.message }
  }
  return readAgentSessionErrorRefusal(error)
    ? { failure: agentSessionThrownFailure(error, rpcCode) }
    : null
}

/** Null when the attempt stopped before its request went out, or was abandoned meanwhile. */
export async function attemptStructuredAgentSessionSend(args: {
  entry: StructuredAgentSessionPendingSend
  target: RuntimeClientTarget
  /** Right before the request goes out: whether to send, and whether an earlier attempt under this
   *  id may have reached the host. */
  beforeIssue: () => { firstAttempt: boolean } | null
  abandoned: () => boolean
}): Promise<StructuredAgentSessionSendAttempt | null> {
  const { entry, target } = args
  let answer: StructuredAgentSessionSendAnswer
  let firstAttempt = !entry.issued
  let answersWithProof = false
  let requested = false
  let blocked: StructuredAgentSessionSendAttempt['blocked'] = null
  try {
    if (target.kind === 'environment') {
      await ensureRuntimeEnvironmentCompatible(target.environmentId)
    }
    const fence = await knownFence(target, entry.sessionId)
    answersWithProof = await hostAnswersWithProof(target)
    const issue = args.abandoned() ? null : args.beforeIssue()
    if (!issue) {
      return null
    }
    firstAttempt = issue.firstAttempt
    requested = true
    const params = structuredAgentSessionMessageSendMutation({
      sessionId: entry.sessionId,
      clientOperationId: entry.clientMessageId,
      expectedRuntimeFence: fence,
      body: entry.body,
      ...(entry.delivery ? { delivery: entry.delivery } : {})
    })
    type SendAnswer = AgentSessionMutationResult<AgentSessionSendResult>
    // Checked above, so the request goes out now or not at all.
    const result =
      target.kind === 'environment'
        ? await callStructuredAgentSession<SendAnswer>(target, 'agentSession.send', params, {
            skipCompatibilityCheck: true
          })
        : await callStructuredAgentSession<SendAnswer>(target, 'agentSession.send', params)
    answer = { kind: 'result', result }
  } catch (error) {
    const rpcCode = error instanceof RuntimeRpcCallError ? error.code : undefined
    answer = { kind: 'thrown', error, rpcCode }
    blocked = requested ? null : blockedBeforeRequest(error, rpcCode)
  }
  if (args.abandoned()) {
    return null
  }
  const value = answer.kind === 'result' && answer.result.ok ? answer.result.value : null
  return {
    evidence: structuredAgentSessionSendEvidence(answer, { answersWithProof, firstAttempt }),
    submission: value && 'submission' in value ? value.submission : null,
    thrownRefusal:
      answer.kind === 'thrown' && readAgentSessionErrorRefusal(answer.error)
        ? agentSessionThrownFailure(answer.error, answer.rpcCode)
        : null,
    blocked
  }
}
