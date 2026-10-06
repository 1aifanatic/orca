import { useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { appendReturnedDraftText } from '../../../src/shared/returned-draft-text'
import { isLoneStructuredAgentSessionConversationCommand } from '../../../src/shared/structured-agent-session-composer'
import type { MobileNativeChatTab } from './mobile-native-chat-eligibility'

/** The session whose drafts the active tab takes: none while any tab shows it, so a cleared chat
 *  reopened from history keeps what is typed there until its tab closes. */
export function mobileReplacedSessionToFollow(
  activeTab: MobileNativeChatTab | null,
  sessionTabs: readonly { type: string; sessionId?: string | null }[] = []
): string | null {
  const replacesSessionId = activeTab?.replacesSessionId
  if (!replacesSessionId) {
    return null
  }
  const shown = sessionTabs.some(
    (tab) => tab.type === 'agent-session' && tab.sessionId === replacesSessionId
  )
  return shown ? null : replacesSessionId
}

/**
 * A /clear moves a tab to the conversation that replaces it, under a new tab id, and the host
 * publishes which conversation it replaced. Whenever the tab that replaced a session shows, every
 * draft kept for that session comes to it, after anything there, whenever it was typed or handed
 * back and whichever tab was showing when the clear ran. A lone /clear or /compact is never
 * carried: the /clear is what replaced it, and a /compact does nothing in a fresh chat.
 */
export function useMobileNativeChatDraftFollowsReplacement(args: {
  draftKey: string | null
  sessionId: string | null
  /** The session the active tab's conversation replaced, as its host published it. */
  replacesSessionId: string | null
  drafts: Readonly<Record<string, string>>
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>
}): void {
  const { draftKey, drafts, replacesSessionId, sessionId, setDrafts } = args
  // Which session each draft was kept for: what a draft key's tab showed when it was active.
  const sessionOfKey = useRef(new Map<string, string>())
  useLayoutEffect(() => {
    if (draftKey && sessionId) {
      sessionOfKey.current.set(draftKey, sessionId)
    }
  }, [draftKey, sessionId])
  useLayoutEffect(() => {
    if (!draftKey || !replacesSessionId) {
      return
    }
    const fromKeys = [...sessionOfKey.current]
      .filter(([key, session]) => session === replacesSessionId && key !== draftKey)
      .map(([key]) => key)
    if (!fromKeys.some((key) => (drafts[key] ?? '') !== '')) {
      return
    }
    setDrafts((current) => {
      const next = { ...current }
      for (const key of fromKeys) {
        const moved = next[key] ?? ''
        delete next[key]
        if (moved !== '' && !isLoneStructuredAgentSessionConversationCommand(moved.trim())) {
          next[draftKey] = appendReturnedDraftText(next[draftKey] ?? '', moved)
        }
      }
      return next
    })
  }, [draftKey, drafts, replacesSessionId, setDrafts])
}
