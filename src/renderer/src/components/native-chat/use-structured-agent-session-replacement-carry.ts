// A /clear's tab link carries the old draft and displays its one pending send where the user is.
// The sender still owns that request and its deadline; nothing here sends it again.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { isLoneStructuredAgentSessionConversationCommand } from '../../../../shared/structured-agent-session-composer'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  appendToNativeChatComposerDraft,
  deleteNativeChatComposerDraft,
  hydrateNativeChatComposerDrafts,
  isNativeChatComposerDraftLoadPending,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  subscribeToNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  EMPTY_STRUCTURED_AGENT_SESSION_SENDS,
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice,
  publishStructuredAgentSessionSends,
  subscribeToStructuredAgentSessionPendingSends
} from './structured-agent-session-pending-sends'
import { settleStructuredAgentSessionSendsFromJournal } from './structured-agent-session-message-sender'
import { recoverLegacyStructuredAgentSessionOutbox } from './structured-agent-session-legacy-outbox'

const NO_SUBSCRIPTION = (): void => {}

/** A lone /clear or /compact belongs to the old context and does not become a new draft. */
function carryDraft(fromSessionId: string, composerScopeKey: string): void {
  const from = structuredAgentSessionDraftScopeKey(fromSessionId)
  const draft = readNativeChatComposerDraft(from)
  if (draft.text === '' && draft.images.length === 0) {
    return
  }
  const command = isLoneStructuredAgentSessionConversationCommand(draft.text.trim())
  if (
    (command && draft.images.length === 0) ||
    appendToNativeChatComposerDraft(composerScopeKey, { text: draft.text, images: draft.images })
  ) {
    deleteNativeChatComposerDraft(from)
  }
}

/** The link is passed only while no tab shows the old chat, so reopening it keeps its own text. */
export function useStructuredAgentSessionReplacementCarry(args: {
  replacesSessionId: string | undefined
  composerScopeKey: string | undefined
  sessionId: string
  target: RuntimeClientTarget
  fence: number | null
  submissions: readonly AgentJournalSubmission[]
  queuedMessageIds: readonly string[]
}) {
  const {
    composerScopeKey,
    fence,
    queuedMessageIds,
    replacesSessionId,
    sessionId,
    submissions,
    target
  } = args
  const fromSessionId = replacesSessionId ?? ''
  const subscribe = useCallback(
    (listener: () => void) =>
      fromSessionId
        ? subscribeToStructuredAgentSessionPendingSends(fromSessionId, listener)
        : NO_SUBSCRIPTION,
    [fromSessionId]
  )
  const pending = useSyncExternalStore(subscribe, () =>
    fromSessionId
      ? getStructuredAgentSessionPendingSends(fromSessionId)
      : EMPTY_STRUCTURED_AGENT_SESSION_SENDS
  )
  const notice = useSyncExternalStore(subscribe, () =>
    fromSessionId ? getStructuredAgentSessionSendNotice(fromSessionId) : null
  )
  const fromDraftScope = fromSessionId ? structuredAgentSessionDraftScopeKey(fromSessionId) : ''
  const subscribeDraft = useCallback(
    (listener: () => void) =>
      fromDraftScope
        ? subscribeToNativeChatComposerDraft(fromDraftScope, listener)
        : NO_SUBSCRIPTION,
    [fromDraftScope]
  )
  const fromDraft = useSyncExternalStore(subscribeDraft, () =>
    readNativeChatComposerDraft(fromDraftScope)
  )
  const [loads, setLoads] = useState(0)
  useEffect(() => {
    if (!fromSessionId || !composerScopeKey) {
      return undefined
    }
    if (!isNativeChatComposerDraftLoadPending()) {
      carryDraft(fromSessionId, composerScopeKey)
      return undefined
    }
    let live = true
    void hydrateNativeChatComposerDrafts().then(() => {
      if (live && !isNativeChatComposerDraftLoadPending()) {
        setLoads((count) => count + 1)
      }
    })
    return () => {
      live = false
    }
  }, [composerScopeKey, fromDraft, fromSessionId, loads])

  useEffect(() => {
    if (fromSessionId && composerScopeKey && notice) {
      publishStructuredAgentSessionSends(sessionId, { notice })
      publishStructuredAgentSessionSends(fromSessionId, { notice: null })
    }
  }, [composerScopeKey, fromSessionId, notice, sessionId])

  useEffect(() => {
    if (fromSessionId && fence !== null) {
      settleStructuredAgentSessionSendsFromJournal(fromSessionId, submissions, queuedMessageIds)
    }
  }, [fence, fromSessionId, pending, queuedMessageIds, submissions])

  const loaded = fromSessionId !== '' && fence !== null
  useEffect(() => {
    if (loaded) {
      void recoverLegacyStructuredAgentSessionOutbox({
        sessionId: fromSessionId,
        target,
        submissions,
        queuedMessageIds
      })
    }
    // Why: the first loaded replacement state is enough; the recovery reads the whole outline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromSessionId, loaded, target])

  return useMemo(() => pending.filter((entry) => entry.phase === 'sending'), [pending])
}
