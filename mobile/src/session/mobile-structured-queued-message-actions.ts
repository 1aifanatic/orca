// Edit (withdraw-to-composer) for one queued draft, and the reload replay that
// finishes any Stop/Edit whose restoration a crash or reload cut short. Both
// answer from the host's op-stamped tombstone receipts, so one operation id is
// one withdrawal and one restoration, however many times it is asked.

import type { AgentSessionQueuedMessageDeleteResult } from '../../../src/shared/agent-session-wire'
import type { AgentSessionConversationCommandResult } from '../../../src/shared/agent-session-conversation-command'
import { sha256 } from '../../../src/shared/sha256'
import type { RpcClient } from '../transport/rpc-client'
import { requestStructuredAgentSessionMutation } from './mobile-structured-agent-session-rpc'
import { queuedMessageBodyText } from './mobile-structured-queued-message-cards'
import {
  discardQueuedRestoreOperation,
  getOrCreateQueuedRestoreOperation,
  listQueuedRestoreOperations,
  queuedRestoreEntryKey,
  settleQueuedRestoreOperation,
  type QueuedRestoreEntry
} from './mobile-structured-queued-restore-journal'
import { structuredSessionOperationId } from './structured-session-operation-id'

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
  const result = await requestStructuredAgentSessionMutation<AgentSessionQueuedMessageDeleteResult>(
    {
      client: input.client,
      method: 'agentSession.queuedMessageDelete',
      fingerprintMethod: 'agentSession.queuedMessageDelete',
      sessionId: input.sessionId,
      expectedRuntimeFence: input.expectedRuntimeFence,
      fields,
      clientOperationId: handle?.operationId ?? structuredSessionOperationId()
    }
  )
  if (result.status === 'accepted') {
    const value = result.value
    if (value.deleted) {
      const apply = (): void => input.appendText(input.draftKey, queuedMessageBodyText(value.body))
      if (handle) {
        await settleQueuedRestoreOperation({ ...handle, restore: apply }).catch(apply)
      } else {
        apply()
      }
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

function replayFields(entry: QueuedRestoreEntry): Record<string, unknown> {
  // A persisted cancel or clear entry is always a withdrawing one; the flag is
  // not stored because it is implied, but the wire fields must match the original.
  if (entry.method === 'agentSession.cancel') {
    return { turnId: entry.fields.turnId, withdrawQueued: true }
  }
  if (entry.method === 'agentSession.conversationCommand') {
    return { command: entry.fields.command, withdrawQueued: true }
  }
  return { messageId: entry.fields.messageId }
}

/**
 * The replacement id a committed clear mints for this exact operation — the host
 * derives it from (source, caller key, operation id), and a mobile caller's key
 * is its device token. The pane showing this id is PROOF the persisted clear
 * already applied, so a same-op reissue can only replay the recorded outcome.
 * If the host's recipe ever changes this fails CLOSED: no recovery, never a run.
 */
export function expectedClearReplacementSessionId(
  entry: {
    sessionId: string
    operationId: string
  },
  callerIdentity: string
): string {
  const digest = sha256(
    new TextEncoder().encode(JSON.stringify([entry.sessionId, callerIdentity, entry.operationId]))
  )
  return `clear-${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Finish restorations a reload interrupted — recovering RESULTS only, never
 * re-executing a command. An operation the host never received would run fresh
 * if reissued, so each method gets only the reissue its evidence makes safe:
 *
 * - Stop: dropped. The host cannot answer a cancel's outcome without running
 *   it, and a fresh run would withdraw the pane's CURRENT drafts and reject
 *   queued sends. Unwithdrawn drafts stay visible as cards; only the narrow
 *   withdrew-then-died window loses its composer restore.
 * - /clear: reissued only when the pane now shows the exact replacement session
 *   this operation's commit would have minted — proof it applied, so the
 *   same-op reissue replays the recorded text from tombstones. Anything else
 *   leaves the entry for a same-id user retry until it expires.
 * - Edit's delete: reissued against its own draft only. A recorded op replays;
 *   an unrecorded one can touch nothing but the single draft the user asked to
 *   withdraw, and a Send that raced it wins the compare-and-transition.
 */
export async function replayQueuedRestoreOperations(input: {
  client: RpcClient
  sessionId: string
  draftKey: string
  callerIdentity: string
  expectedRuntimeFence: number
  appendText: QueuedRestoreTextSink
}): Promise<void> {
  const entries = await listQueuedRestoreOperations({ draftKey: input.draftKey }).catch(
    () => [] as QueuedRestoreEntry[]
  )
  for (const entry of entries) {
    const request = { ...input, entry }
    if (entry.method === 'agentSession.cancel') {
      await discardQueuedRestoreOperation({
        entryKey: entry.entryKey,
        operationId: entry.operationId
      }).catch(() => undefined)
    } else if (entry.method === 'agentSession.conversationCommand') {
      if (input.sessionId === expectedClearReplacementSessionId(entry, input.callerIdentity)) {
        await replayOne<AgentSessionConversationCommandResult>(request, (value) =>
          // A command still in doubt keeps its entry for the next open.
          value.state === 'unknown'
            ? null
            : (value.withdrawnQueued ?? []).map((withdrawn) =>
                queuedMessageBodyText(withdrawn.body)
              )
        )
      }
    } else if (entry.sessionId === input.sessionId) {
      await replayOne<AgentSessionQueuedMessageDeleteResult>(request, (value) =>
        value.deleted ? [queuedMessageBodyText(value.body)] : []
      )
    }
  }
}

async function replayOne<TValue>(
  input: {
    client: RpcClient
    expectedRuntimeFence: number
    appendText: QueuedRestoreTextSink
    entry: QueuedRestoreEntry
  },
  /** Null = the answer proves nothing yet; keep the entry. */
  owedTexts: (value: TValue) => string[] | null
): Promise<void> {
  const { entry } = input
  const result = await requestStructuredAgentSessionMutation<TValue>({
    client: input.client,
    method: entry.method,
    fingerprintMethod: entry.method,
    // The operation's own recorded target — for a clear the pane has already
    // moved to the replacement, but the tombstones live on the source.
    sessionId: entry.sessionId,
    expectedRuntimeFence: input.expectedRuntimeFence,
    fields: replayFields(entry),
    clientOperationId: entry.operationId
  })
  if (result.status === 'accepted') {
    const texts = owedTexts(result.value)
    if (texts === null) {
      return
    }
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
