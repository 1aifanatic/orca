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
import {
  callRuntimeRpc,
  ensureRuntimeEnvironmentCompatible,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { supportsStructuredAgentSessionSendAnswersProof } from '@/runtime/structured-agent-session-client'
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

async function knownFence(target: RuntimeClientTarget, sessionId: string): Promise<number> {
  const known = fences.get(sessionId)
  if (known !== undefined) {
    return known
  }
  // Current hosts ignore it; an older host checks it, so read the one it serves now.
  const history = await callRuntimeRpc<AgentSessionHistoryResult>(target, 'agentSession.history', {
    sessionId,
    direction: 'tail',
    limit: 1
  })
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
  try {
    if (target.kind === 'environment') {
      await ensureRuntimeEnvironmentCompatible(target.environmentId)
    }
    const fence = await knownFence(target, entry.sessionId)
    answersWithProof = await supportsStructuredAgentSessionSendAnswersProof(target)
    const issue = args.abandoned() ? null : args.beforeIssue()
    if (!issue) {
      return null
    }
    firstAttempt = issue.firstAttempt
    const result = await callRuntimeRpc<AgentSessionMutationResult<AgentSessionSendResult>>(
      target,
      'agentSession.send',
      structuredAgentSessionMessageSendMutation({
        sessionId: entry.sessionId,
        clientOperationId: entry.clientMessageId,
        expectedRuntimeFence: fence,
        body: entry.body,
        ...(entry.delivery ? { delivery: entry.delivery } : {})
      }),
      { skipCompatibilityCheck: true }
    )
    answer = { kind: 'result', result }
  } catch (error) {
    answer = {
      kind: 'thrown',
      error,
      rpcCode: error instanceof RuntimeRpcCallError ? error.code : undefined
    }
  }
  if (args.abandoned()) {
    return null
  }
  const value = answer.kind === 'result' && answer.result.ok ? answer.result.value : null
  return {
    evidence: structuredAgentSessionSendEvidence(answer, { answersWithProof, firstAttempt }),
    submission: value && 'submission' in value ? value.submission : null
  }
}
