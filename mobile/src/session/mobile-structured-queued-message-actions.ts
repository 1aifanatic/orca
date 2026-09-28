// Edit (withdraw-to-composer) for one queued draft, the lost-answer re-ask every
// withdrawing mutation shares, and the reload replay that finishes an Edit a
// crash cut short. All answer from the host's op-stamped tombstone receipts, so
// one operation id is one withdrawal and one restoration, however often asked.

import type { AgentSessionQueuedMessageDeleteResult } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import {
  requestStructuredAgentSessionMutation,
  type StructuredAgentSessionMutationCallResult
} from './mobile-structured-agent-session-rpc'
import { queuedMessageBodyText } from './mobile-structured-queued-message-cards'
import {
  discardQueuedRestoreOperation,
  getOrCreateQueuedRestoreOperation,
  queuedRestoreEntryKey,
  restoreQueuedTextOnce,
  settleQueuedRestoreOperation,
  takeRelaunchQueuedRestoreOperations,
  type QueuedRestoreEntry
} from './mobile-structured-queued-restore-journal'
import { structuredSessionOperationId } from './structured-session-operation-id'

/** First ask plus re-asks; each waits out its own reconnect budget. */
const WITHDRAWING_MUTATION_ATTEMPTS = 3

/**
 * A withdrawing Stop, /clear or Edit whose answer was lost is re-asked under the
 * SAME operation id: once the host committed, the card is gone and only this
 * answer carries the text back, and a recorded id replays from the tombstones
 * instead of running again. A host that reports the id unknown is not re-asked.
 */
export async function requestWithdrawingMutation<TValue>(
  args: Parameters<typeof requestStructuredAgentSessionMutation>[0] & { clientOperationId: string },
  attemptsLeft = WITHDRAWING_MUTATION_ATTEMPTS
): Promise<StructuredAgentSessionMutationCallResult<TValue>> {
  const result = await requestStructuredAgentSessionMutation<TValue>(args)
  return result.status === 'unknown' && !result.hostReportedOperationUnknown && attemptsLeft > 1
    ? requestWithdrawingMutation<TValue>(args, attemptsLeft - 1)
    : result
}

export type QueuedRestoreTextSink = (draftKey: string, text: string) => void

/**
 * Edit = Delete + the returned body into the composer. The operation identity is
 * persisted before the RPC so the reclaimed text survives a reload between the
 * host's withdrawal and the composer write.
 */
export async function editMobileQueuedMessage(input: {
  client: RpcClient
  sessionId: string
  sessionKey: string
  expectedRuntimeFence: number
  messageId: string
  draftKey: string
  appendText: QueuedRestoreTextSink
  onSendError: (message: string) => void
}): Promise<boolean> {
  const fields = { messageId: input.messageId }
  const entryKey = queuedRestoreEntryKey({
    sessionKey: input.sessionKey,
    method: 'agentSession.queuedMessageDelete',
    fields
  })
  let handle: { entryKey: string; operationId: string } | null = null
  try {
    const operation = await getOrCreateQueuedRestoreOperation({
      entryKey,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      draftKey: input.draftKey,
      method: 'agentSession.queuedMessageDelete',
      fields,
      createOperationId: structuredSessionOperationId
    })
    handle = { entryKey, operationId: operation.operationId }
  } catch {
    handle = null
  }
  const result = await requestWithdrawingMutation<AgentSessionQueuedMessageDeleteResult>({
    client: input.client,
    method: 'agentSession.queuedMessageDelete',
    fingerprintMethod: 'agentSession.queuedMessageDelete',
    sessionId: input.sessionId,
    expectedRuntimeFence: input.expectedRuntimeFence,
    fields,
    clientOperationId: handle?.operationId ?? structuredSessionOperationId()
  })
  if (result.status === 'accepted') {
    const value = result.value
    if (value.deleted) {
      const apply = (): void => input.appendText(input.draftKey, queuedMessageBodyText(value.body))
      await restoreQueuedTextOnce(handle, apply)
      return true
    }
    if (handle) {
      await discardQueuedRestoreOperation(handle).catch(() => undefined)
    }
    if (value.disposition === 'dispatched') {
      input.onSendError('This message was already sent.')
    }
    return false
  }
  if (handle && result.status !== 'unknown') {
    await discardQueuedRestoreOperation(handle).catch(() => undefined)
  }
  if (result.status === 'refused' || result.status === 'failed') {
    input.onSendError(result.message)
  }
  return false
}

/**
 * Finish the Edits a reload interrupted, once per pane per app process. Stop and
 * /clear handles are released instead (takeRelaunchQueuedRestoreOperations):
 * the host cannot answer their outcome without running them, and their
 * unwithdrawn drafts stay visible as cards. An Edit's delete is reissued against
 * its own draft only — a recorded op replays its body from the tombstone; an
 * unrecorded one withdraws nothing but the draft the user asked to edit, and a
 * Send that raced it wins the compare-and-transition.
 */
export async function replayQueuedRestoreOperations(input: {
  client: RpcClient
  sessionId: string
  draftKey: string
  expectedRuntimeFence: number
  appendText: QueuedRestoreTextSink
}): Promise<void> {
  let entries: QueuedRestoreEntry[] = []
  try {
    entries = await takeRelaunchQueuedRestoreOperations({ draftKey: input.draftKey })
  } catch {
    return
  }
  await Promise.all(
    entries.map((entry) =>
      entry.method === 'agentSession.queuedMessageDelete' && entry.sessionId === input.sessionId
        ? replayEdit({ ...input, entry })
        : undefined
    )
  )
}

async function replayEdit(input: {
  client: RpcClient
  expectedRuntimeFence: number
  appendText: QueuedRestoreTextSink
  entry: Extract<QueuedRestoreEntry, { method: 'agentSession.queuedMessageDelete' }>
}): Promise<void> {
  const { entry } = input
  const result = await requestWithdrawingMutation<AgentSessionQueuedMessageDeleteResult>({
    client: input.client,
    method: entry.method,
    fingerprintMethod: entry.method,
    sessionId: entry.sessionId,
    expectedRuntimeFence: input.expectedRuntimeFence,
    fields: { messageId: entry.fields.messageId },
    clientOperationId: entry.operationId
  })
  if (result.status === 'accepted') {
    const texts = result.value.deleted ? [queuedMessageBodyText(result.value.body)] : []
    await settleQueuedRestoreOperation({
      entryKey: entry.entryKey,
      operationId: entry.operationId,
      restore: () => {
        for (const text of texts) {
          input.appendText(entry.draftKey, text)
        }
      }
    }).catch(() => undefined)
    return
  }
  if (result.status !== 'unknown') {
    await discardQueuedRestoreOperation({
      entryKey: entry.entryKey,
      operationId: entry.operationId
    }).catch(() => undefined)
  }
}
