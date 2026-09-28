import type { AgentSessionConversationCommandResult } from '../../../src/shared/agent-session-conversation-command'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand,
  type StructuredAgentSessionComposerOptions
} from '../../../src/shared/structured-agent-session-composer'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import {
  requestStructuredAgentSessionMutation,
  retainStructuredSessionOperationId
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

export async function dispatchMobileStructuredCommand(input: {
  text: string
  hasAttachments: boolean
  client: RpcClient
  sessionId: string
  fence: number
  sessionKey: string
  pending: { current: boolean }
  operationIds: Map<string, string>
  controller: StructuredAgentSessionComposerOptions
  canRun: () => boolean
  /** Capable hosts only: /clear also withdraws queued drafts and this restores
   *  their text, write-ahead persisted like the Stop path. */
  clearWithdrawal?: { draftKey: string; appendText: (draftKey: string, text: string) => void }
  onError: (message: string) => void
  timeoutMs: number
}): Promise<MobileNativeChatSendOutcome | null> {
  if (input.pending.current) {
    return 'rejected'
  }
  if (!isStructuredAgentSessionComposerCommand(input.text, input.controller.agent)) {
    return null
  }
  if (input.hasAttachments) {
    input.onError('Remove attachments before using a chat-session command.')
    return 'rejected'
  }
  let unknown = false
  const outcome = await dispatchStructuredAgentSessionComposerCommand(input.text, {
    ...input.controller,
    runConversationCommand: async (command) => {
      if (!input.canRun()) {
        return {
          accepted: false,
          error: 'Wait for pending work to finish before using this command.'
        }
      }
      input.pending.current = true
      const withdrawal = command === 'clear' ? input.clearWithdrawal : undefined
      // The flag changes the fingerprint, so a retained plain-clear id must not replay it.
      const key = `${input.sessionKey}:agentSession.conversationCommand:${command}${withdrawal ? ':withdraw' : ''}`
      let handle: { entryKey: string; operationId: string } | null = null
      if (withdrawal) {
        const entryKey = queuedRestoreEntryKey({
          sessionKey: input.sessionKey,
          method: 'agentSession.conversationCommand',
          fields: { command: 'clear' }
        })
        try {
          // Persist-before-request, so a reload between the host's withdrawal
          // and the composer restore keeps the replay handle.
          const operation = await getOrCreateQueuedRestoreOperation({
            entryKey,
            sessionId: input.sessionId,
            sessionKey: input.sessionKey,
            draftKey: withdrawal.draftKey,
            method: 'agentSession.conversationCommand',
            fields: { command: 'clear' },
            createOperationId: structuredSessionOperationId
          })
          handle = { entryKey, operationId: operation.operationId }
        } catch {
          // Bookkeeping never gates the command; run it without a durable handle.
          handle = null
        }
      }
      const clientOperationId =
        handle?.operationId ??
        retainStructuredSessionOperationId(input.operationIds, key, input.operationIds.get(key))
      try {
        const request = {
          client: input.client,
          sessionId: input.sessionId,
          expectedRuntimeFence: input.fence,
          method: 'agentSession.conversationCommand',
          fingerprintMethod: 'agentSession.conversationCommand',
          fields: { command, ...(withdrawal ? { withdrawQueued: true as const } : {}) },
          clientOperationId,
          timeoutMs: Math.max(input.timeoutMs, 195_000)
        }
        // A withdrawing clear re-asks a lost answer: only it carries the drafts' text back.
        const result = withdrawal
          ? await requestWithdrawingMutation<AgentSessionConversationCommandResult>(request)
          : await requestStructuredAgentSessionMutation<AgentSessionConversationCommandResult>(
              request
            )
        if (
          result.status === 'unknown' ||
          (result.status === 'accepted' && result.value.state === 'unknown')
        ) {
          unknown = true
          return {
            accepted: false,
            error: 'Conversation operation is unconfirmed; retry checks the same operation.'
          }
        }
        input.operationIds.delete(key)
        if (result.status === 'accepted' && withdrawal) {
          const texts = (result.value.withdrawnQueued ?? []).map((entry) =>
            queuedMessageBodyText(entry.body)
          )
          const apply = (): void => {
            for (const text of texts) {
              withdrawal.appendText(withdrawal.draftKey, text)
            }
          }
          if (handle) {
            // Settled through the journal so the bodies are restored exactly once.
            await settleQueuedRestoreOperation({ ...handle, restore: apply }).catch(apply)
          } else {
            apply()
          }
        } else if (handle) {
          // The host answered definitively without owing text; the handle is dead.
          await discardQueuedRestoreOperation(handle).catch(() => undefined)
        }
        return result.status === 'accepted'
          ? { accepted: !result.value.error, error: result.value.error ?? null }
          : { accepted: false, error: result.message }
      } finally {
        input.pending.current = false
      }
    }
  })
  if (outcome.error) {
    input.onError(outcome.error)
  }
  return unknown ? 'unknown' : outcome.accepted ? 'accepted' : 'rejected'
}
