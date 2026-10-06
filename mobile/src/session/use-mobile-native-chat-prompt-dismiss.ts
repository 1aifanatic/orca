import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

type PromptDismissal = { sessionKey: string | null; promptKey: string }
type DetectedPrompt = { sessionKey: string | null; promptKey: string | null }

/** Presentation only: retain one answered occurrence per tab until observations supersede it. */
export function useMobileNativeChatPromptDismiss({
  promptKey,
  detectedPromptKey,
  scopeKey,
  sessionKey,
  observing
}: {
  promptKey: string | null
  detectedPromptKey: string | null
  scopeKey: string | null
  sessionKey: string | null
  observing: boolean
}): { showPrompt: boolean; dismissPrompt: () => void } {
  const observation = useMemo(
    () => ({ sessionKey, promptKey: detectedPromptKey }),
    [sessionKey, detectedPromptKey, scopeKey]
  )
  const detectedByScopeRef = useRef(new Map<string | null, DetectedPrompt>())
  const [dismissedByScope, setDismissedByScope] = useState<Map<string | null, PromptDismissal>>(
    () => new Map()
  )
  useLayoutEffect(() => {
    if (observing) {
      detectedByScopeRef.current.set(scopeKey, observation)
    }
  }, [observing, detectedPromptKey, scopeKey, sessionKey, observation])
  // A cleared or genuinely different detected prompt retires the old dismissal.
  useEffect(() => {
    if (observing) {
      setDismissedByScope((previous) => {
        const dismissed = previous.get(scopeKey)
        if (
          dismissed === undefined ||
          (dismissed.sessionKey === sessionKey && dismissed.promptKey === detectedPromptKey)
        ) {
          return previous
        }
        const next = new Map(previous)
        next.delete(scopeKey)
        return next
      })
    }
  }, [observing, detectedPromptKey, scopeKey, sessionKey])
  const dismissed = dismissedByScope.get(scopeKey)
  const showPrompt =
    promptKey !== null &&
    !(dismissed?.sessionKey === sessionKey && dismissed.promptKey === promptKey)
  const dismissPrompt = (): void => {
    const detected = detectedByScopeRef.current.get(scopeKey)
    if (
      promptKey !== null &&
      detected === observation &&
      detected.sessionKey === sessionKey &&
      detected.promptKey === promptKey
    ) {
      setDismissedByScope((previous) => {
        const current = previous.get(scopeKey)
        if (current?.sessionKey === sessionKey && current.promptKey === promptKey) {
          return previous
        }
        return new Map(previous).set(scopeKey, { sessionKey, promptKey })
      })
    }
  }

  return { showPrompt, dismissPrompt }
}
