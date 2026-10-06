import { useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { appendReturnedDraftText } from '../../../src/shared/returned-draft-text'
import { isLoneStructuredAgentSessionConversationCommand } from '../../../src/shared/structured-agent-session-composer'

/**
 * A /clear moves a tab to the conversation that replaces it, under a new tab id, and the host
 * publishes which conversation it replaced. Whenever the tab that replaced a session shows, every
 * draft kept for that session comes to it, after anything there, whenever it was typed or handed
 * back and whichever tab was showing when the clear ran. A lone command is the /clear that
 * replaced it, never carried.
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
