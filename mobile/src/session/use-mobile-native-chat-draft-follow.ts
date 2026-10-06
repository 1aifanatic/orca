import { useCallback, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { appendReturnedDraftText } from '../../../src/shared/returned-draft-text'

/**
 * A /clear moves the tab to the conversation that replaces it, under a new tab id. What was typed
 * under the old one goes along, after anything there, and text a send's answer hands back later
 * to the old one lands in the new one. Returns where a draft key's text belongs now.
 */
export function useMobileNativeChatDraftFollowsReplacement(args: {
  draftKey: string | null
  sessionId: string | null
  /** The session the active tab's conversation replaced, as its host published it. */
  replacesSessionId: string | null
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>
}): (draftKey: string) => string {
  const { draftKey, sessionId, replacesSessionId, setDrafts } = args
  const forwarded = useRef(new Map<string, string>())
  const previous = useRef({ draftKey, sessionId })
  useLayoutEffect(() => {
    const from = previous.current
    previous.current = { draftKey, sessionId }
    if (
      !draftKey ||
      !from.draftKey ||
      from.draftKey === draftKey ||
      !replacesSessionId ||
      from.sessionId !== replacesSessionId
    ) {
      return
    }
    const fromKey = from.draftKey
    forwarded.current.set(fromKey, draftKey)
    setDrafts((drafts) => {
      const moved = drafts[fromKey] ?? ''
      if (moved === '') {
        return drafts
      }
      const { [fromKey]: _left, ...rest } = drafts
      return { ...rest, [draftKey]: appendReturnedDraftText(drafts[draftKey] ?? '', moved) }
    })
  }, [draftKey, replacesSessionId, sessionId, setDrafts])
  return useCallback((key: string) => {
    const seen = new Set<string>()
    let current = key
    while (forwarded.current.has(current) && !seen.has(current)) {
      seen.add(current)
      current = forwarded.current.get(current)!
    }
    return current
  }, [])
}
