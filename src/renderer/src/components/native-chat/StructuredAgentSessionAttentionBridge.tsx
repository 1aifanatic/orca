import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  registerAgentSubjectReadCapture,
  subscribeAgentSubjectReads,
  sameStructuredReadTarget
} from '@/attention/agent-subject-read-actions'
import { findStructuredAgentSessionReadOwner } from './structured-agent-session-read-owner'
import { structuredAttentionReadObservation } from './structured-attention-read-observation'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import { getStructuredAgentSessionTurnCompletionFeed } from '@/runtime/structured-agent-session-turn-completion-feed'
import { acknowledgeStructuredAgentSessionAttention } from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import {
  dispatchStructuredPromptAttention,
  dispatchStructuredTurnCompletionAttention
} from './structured-attention-dispatch'
import { getStructuredAgentSessionTabs, type StructuredTab } from './structured-agent-session-tabs'

/**
 * One subscription per open structured tab, so a finished or asking chat lights its unread
 * indicators whether or not its transcript is on screen, and reading it withdraws the phone alerts
 * its host pushed.
 *
 * Subscribing per tab rather than once per host is what makes this correct, not just convenient:
 * the tab IS the attention surface. A completion for a session with no open tab has no surface to
 * mark and no liveness evidence in this process, and the surface adapter would reject it anyway.
 */
function StructuredAgentSessionAttention({
  tab
}: {
  tab: StructuredTab
}): React.JSX.Element | null {
  // The same owner the chat pane and status bridge read, so all of them follow one host.
  const owner = useAppStore((state) => structuredAgentSessionOwnerForTab(state, tab))
  const target = useMemo(() => structuredAgentSessionTargetForHost(owner), [owner])
  return target ? <StructuredAgentSessionOwnedAttention tab={tab} target={target} /> : null
}

function StructuredAgentSessionOwnedAttention({
  tab,
  target
}: {
  tab: StructuredTab
  target: RuntimeClientTarget
}): null {
  const feed = useMemo(() => getStructuredAgentSessionTurnCompletionFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  useEffect(() => {
    let lastAttempt: { observationKey: string } | undefined
    const stopCapture = registerAgentSubjectReadCapture(paneKey, () => {
      const state = findStructuredAgentSessionReadOwner(tab.entityId, target)?.getSnapshot().state
      if (!state?.cursor) {
        return null
      }
      return {
        target,
        sessionId: tab.entityId,
        observedCursor: { ...state.cursor },
        observationKey: structuredAttentionReadObservation(state)
      }
    })
    const stopRead = subscribeAgentSubjectReads((reads) => {
      const read = reads.find((entry) => entry.subjectKey === paneKey)?.structured
      if (
        !read ||
        read.sessionId !== tab.entityId ||
        !sameStructuredReadTarget(read.target, target) ||
        read.observationKey === lastAttempt?.observationKey
      ) {
        return
      }
      const attempt = { observationKey: read.observationKey }
      lastAttempt = attempt
      const localRetirement = (async (): Promise<boolean> => {
        try {
          await window.api?.notifications?.dismiss?.(
            [],
            [paneKey],
            [{ paneKey, sessionId: read.sessionId, observedCursor: read.observedCursor }]
          )
          return true
        } catch (error) {
          console.warn('[structured-session-attention] local retirement failed', error)
          return false
        }
      })()
      void Promise.all([
        localRetirement,
        acknowledgeStructuredAgentSessionAttention(target, read.sessionId, read.observedCursor)
      ]).then((results) => {
        // An older result cannot release a newer read when the prompt set repeats.
        if (lastAttempt === attempt && results.some((succeeded) => !succeeded)) {
          lastAttempt = undefined
        }
      })
    })
    return () => {
      stopRead()
      stopCapture()
    }
  }, [paneKey, tab.entityId, target])
  useEffect(
    () =>
      feed.subscribe((edge) => {
        if (edge.type === 'prompt') {
          if (edge.prompt.sessionId === tab.entityId) {
            dispatchStructuredPromptAttention(tab, edge.prompt, target)
          }
        } else if (edge.completion.sessionId === tab.entityId) {
          dispatchStructuredTurnCompletionAttention(tab, edge.completion, target)
        }
      }),
    [feed, tab, target]
  )
  return null
}

export function StructuredAgentSessionAttentionBridge(): React.JSX.Element {
  const tabs = useAppStore(
    useShallow((state) => getStructuredAgentSessionTabs(state.unifiedTabsByWorktree))
  )
  return (
    <>
      {tabs.map((tab) => (
        <StructuredAgentSessionAttention key={`${tab.id}:${tab.entityId}`} tab={tab} />
      ))}
    </>
  )
}
