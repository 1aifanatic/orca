import type { AgentSessionCancelResult } from '../../../src/shared/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import { activeStructuredAgentSessionTurnId } from '../../../src/shared/structured-agent-session-live-turn'
import type { RpcClient } from '../transport/rpc-client'
import {
  requestStructuredAgentSessionMutation,
  retainStructuredSessionOperationId,
  type StructuredAgentSessionMutationCallResult
} from './mobile-structured-agent-session-rpc'
import { requestWithdrawingMutation } from './mobile-structured-queued-message-actions'
import { queuedMessageBodyText } from './mobile-structured-queued-message-cards'
import {
  discardQueuedRestoreOperation,
  getOrCreateQueuedRestoreOperation,
  queuedRestoreEntryKey,
  settleQueuedRestoreOperation
} from './mobile-structured-queued-restore-journal'
import { structuredSessionOperationId } from './structured-session-operation-id'

type PromptIdentity = { itemId: string; expectedRevision: number }

/** Where a withdrawing Stop puts the drafts' text back. */
export type QueuedComposerRestore = {
  /** Composer scope of the pane the Stop was issued from. */
  draftKey: string
  appendText: (draftKey: string, text: string) => void
}

export function pendingStructuredPromptIdentity(
  items: readonly AgentJournalRenderItem[]
): PromptIdentity | undefined {
  const prompt = items.find((item) =>
    item.body.kind === 'approval' || item.body.kind === 'question'
      ? item.body.resolution.state === 'pending'
      : false
  )
  return prompt ? { itemId: prompt.itemId, expectedRevision: prompt.revision } : undefined
}

export async function requestMobileStructuredAgentSessionCancel(args: {
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  stateRef: { readonly current: StructuredAgentSessionState }
  sessionKey: string
  operationIds: Map<string, string>
  promptCancelSupported: boolean | null
  /** Present only when the host advertises queued messages AND this Stop names no
   *  prompt: the cancel then also withdraws waiting/returned drafts and restores
   *  their text through `withdraw.appendText`, write-ahead persisted per §5.1. */
  withdraw?: QueuedComposerRestore
  prompt?: PromptIdentity
  onSendError: (message: string) => void
}): Promise<boolean> {
  const { client, enabled, onSendError, operationIds, sessionId, sessionKey, stateRef } = args
  const current = stateRef.current
  const turnId = activeStructuredAgentSessionTurnId(current.items)
  if (!client || !sessionId || !enabled || current.fence === null || !turnId) {
    onSendError('Stop not sent')
    return false
  }
  // The params schema allows withdrawQueued only on a plain conversation Stop.
  const withdraw = args.prompt ? undefined : args.withdraw
  // Check the capability before fields enter either the fingerprint or operation key.
  const fields = {
    turnId,
    ...(withdraw ? { withdrawQueued: true as const } : {}),
    ...(args.prompt && args.promptCancelSupported === true ? { prompt: args.prompt } : {})
  }
  let restoreHandle: { entryKey: string; operationId: string } | null = null
  if (withdraw) {
    const entryKey = queuedRestoreEntryKey({
      sessionKey,
      method: 'agentSession.cancel',
      fields: { turnId }
    })
    try {
      // Persist-before-request: the replay handle survives a crash between the
      // host's withdrawal and the composer restore below.
      const operation = await getOrCreateQueuedRestoreOperation({
        entryKey,
        sessionId,
        sessionKey,
        draftKey: withdraw.draftKey,
        method: 'agentSession.cancel',
        fields: { turnId },
        createOperationId: structuredSessionOperationId
      })
      restoreHandle = { entryKey, operationId: operation.operationId }
    } catch {
      // Bookkeeping never gates a Stop: proceed without a durable handle.
      restoreHandle = null
    }
  }
  const key = `${sessionKey}:agentSession.cancel:${JSON.stringify(fields)}`
  const clientOperationId =
    restoreHandle?.operationId ??
    retainStructuredSessionOperationId(operationIds, key, operationIds.get(key))
  const request = {
    client,
    method: 'agentSession.cancel',
    fingerprintMethod: 'agentSession.cancel',
    sessionId,
    expectedRuntimeFence: current.fence,
    fields,
    clientOperationId
  }
  // A withdrawing Stop re-asks a lost answer: only it carries the drafts' text back.
  const result: StructuredAgentSessionMutationCallResult<AgentSessionCancelResult> = withdraw
    ? await requestWithdrawingMutation<AgentSessionCancelResult>(request)
    : await requestStructuredAgentSessionMutation<AgentSessionCancelResult>(request)
  // Cancel's plan recovers no unknown ledger row, so an id the host answered that
  // way earns the same refusal until it expires; keeping it leaves Stop unusable.
  // Transport doubt proves nothing about delivery, so it stays a replay.
  if (result.status !== 'unknown' || result.hostReportedOperationUnknown === true) {
    operationIds.delete(key)
  }
  if (result.status === 'accepted') {
    if (withdraw) {
      const texts = (result.value.withdrawnQueued ?? []).map((entry) =>
        queuedMessageBodyText(entry.body)
      )
      const apply = (): void => {
        for (const text of texts) {
          withdraw.appendText(withdraw.draftKey, text)
        }
      }
      if (restoreHandle) {
        // Settled through the journal so the bodies are restored exactly once.
        await settleQueuedRestoreOperation({ ...restoreHandle, restore: apply }).catch(apply)
      } else {
        apply()
      }
    }
    return true
  }
  if (restoreHandle && (result.status !== 'unknown' || result.hostReportedOperationUnknown)) {
    // The host answered without owing text (or burned the id); the handle is dead.
    await discardQueuedRestoreOperation(restoreHandle).catch(() => undefined)
  }
  if (result.status === 'unknown') {
    onSendError('Stop unconfirmed — check chat before retrying')
  } else if (result.status === 'refused') {
    onSendError(result.message)
  } else if (result.status === 'failed') {
    onSendError(result.message)
  }
  return false
}
