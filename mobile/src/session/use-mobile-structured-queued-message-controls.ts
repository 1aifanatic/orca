// The queued-draft surface the structured session exposes: cards derived from
// the published list, the Send-now / Delete / Edit actions, and the reload
// replay that finishes restorations a crash interrupted. All of it is gated on
// the host capability — an incapable host gets no cards and no new fields.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type {
  AgentSessionQueuedMessageDeleteResult,
  AgentSessionSendResult
} from '../../../src/shared/agent-session-wire'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import type { QueuedComposerRestore } from './mobile-structured-agent-session-cancel'
import {
  editMobileQueuedMessage,
  replayQueuedRestoreOperations,
  type QueuedRestoreTextSink
} from './mobile-structured-queued-message-actions'
import {
  mobileQueuedMessageCards,
  type MobileQueuedMessageCard
} from './mobile-structured-queued-message-cards'
import type { MobileQueuedMessageFeed } from './mobile-structured-queued-message-feed'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'

/** Composer scope + writer for Stop/Edit text restoration; absent = restore is dropped. */
export type MobileQueuedComposerRestoreSeam = {
  readDraftKey: () => string | null
  appendText: QueuedRestoreTextSink
}

export type MobileStructuredQueuedMessageControls = {
  /** Host-held drafts as cards above the composer; empty off capable hosts. */
  cards: MobileQueuedMessageCard[]
  /** Send-now: dispatch this draft into or ahead of the running turn. */
  send: (messageId: string) => Promise<boolean>
  /** Discard the draft. */
  delete: (messageId: string) => Promise<boolean>
  /** Withdraw the draft and put its text back in the composer. */
  edit: (messageId: string) => Promise<boolean>
}

export function useMobileStructuredQueuedMessageControls(args: {
  client: RpcClient | null
  sessionId: string | null
  sessionKey: string
  enabled: boolean
  queueCapable: boolean
  composerRestore: MobileQueuedComposerRestoreSeam | undefined
  stateRef: { readonly current: StructuredAgentSessionState }
  fence: number | null
  queuedMessages: MobileQueuedMessageFeed
  pendingPrompt: boolean
  mutate: MobileStructuredAgentMutate
  onSendError: (message: string) => void
  /** Called on any accepted card action, so the route can retire a held failure banner. */
  onActionResolved?: () => void
}): MobileStructuredQueuedMessageControls & {
  /** What a capable Stop hands the cancel path, or undefined off capable hosts. */
  composerWithdraw: () => QueuedComposerRestore | undefined
} {
  const {
    client,
    composerRestore,
    enabled,
    fence,
    mutate,
    onActionResolved,
    onSendError,
    pendingPrompt,
    queueCapable,
    queuedMessages,
    sessionId,
    sessionKey,
    stateRef
  } = args
  const cards = useMemo(
    () => (queueCapable ? mobileQueuedMessageCards(queuedMessages, { pendingPrompt }) : []),
    [pendingPrompt, queueCapable, queuedMessages]
  )
  const resolved = useCallback(
    (accepted: boolean): boolean => {
      if (accepted) {
        onActionResolved?.()
      }
      return accepted
    },
    [onActionResolved]
  )
  const send = useCallback(
    async (messageId: string): Promise<boolean> =>
      resolved(
        (
          await mutate<AgentSessionSendResult>(
            'agentSession.queuedMessageSend',
            'agentSession.queuedMessageSend',
            { messageId }
          )
        ).status === 'accepted'
      ),
    [mutate, resolved]
  )
  const deleteDraft = useCallback(
    async (messageId: string): Promise<boolean> => {
      const result = await mutate<AgentSessionQueuedMessageDeleteResult>(
        'agentSession.queuedMessageDelete',
        'agentSession.queuedMessageDelete',
        { messageId }
      )
      if (result.status !== 'accepted') {
        return false
      }
      if (!result.value.deleted && result.value.disposition === 'dispatched') {
        // Delete raced the drain; the message went out and is in the transcript.
        onSendError('This message was already sent.')
        return false
      }
      return resolved(true)
    },
    [mutate, onSendError, resolved]
  )
  const edit = useCallback(
    async (messageId: string): Promise<boolean> => {
      const currentFence = stateRef.current.fence
      const restore = composerRestore
      const draftKey = restore?.readDraftKey() ?? null
      if (!client || !sessionId || !enabled || currentFence === null || !restore || !draftKey) {
        return false
      }
      return resolved(
        await editMobileQueuedMessage({
          client,
          sessionId,
          sessionKey,
          expectedRuntimeFence: currentFence,
          messageId,
          draftKey,
          appendText: restore.appendText,
          onSendError
        })
      )
    },
    [client, composerRestore, enabled, onSendError, resolved, sessionId, sessionKey, stateRef]
  )
  const composerWithdraw = useCallback((): QueuedComposerRestore | undefined => {
    if (!queueCapable || !composerRestore) {
      return undefined
    }
    const draftKey = composerRestore.readDraftKey()
    return draftKey ? { draftKey, appendText: composerRestore.appendText } : undefined
  }, [composerRestore, queueCapable])
  // Finish restorations a reload interrupted, once per opened chat. Recorded
  // operations replay from tombstones; nothing here can interrupt new work.
  const replayedRestoreKeysRef = useRef(new Set<string>())
  useEffect(() => {
    if (!queueCapable || !client || !sessionId || !enabled || fence === null || !composerRestore) {
      return
    }
    if (replayedRestoreKeysRef.current.has(sessionKey)) {
      return
    }
    replayedRestoreKeysRef.current.add(sessionKey)
    void replayQueuedRestoreOperations({
      client,
      sessionId,
      sessionKey,
      expectedRuntimeFence: fence,
      appendText: composerRestore.appendText
    }).catch(() => undefined)
  }, [client, composerRestore, enabled, fence, queueCapable, sessionId, sessionKey])
  return { cards, send, delete: deleteDraft, edit, composerWithdraw }
}
