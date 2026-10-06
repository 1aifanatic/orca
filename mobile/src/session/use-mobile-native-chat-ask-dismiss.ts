import { useMemo } from 'react'
import { nativeChatAskDismissKey, type AskPrompt } from '../../../src/shared/native-chat-ask'
import { useMobileNativeChatPromptDismiss } from './use-mobile-native-chat-prompt-dismiss'

/** Keep an answered ask hidden across view toggles and remounts until a real observation supersedes it. */
export function useMobileNativeChatAskDismiss(args: {
  ask: AskPrompt | null
  detectedAsk: AskPrompt | null
  scopeKey: string | null
  sessionKey: string | null
  observing: boolean
}): { askKey: string | null; showAsk: boolean; dismissAsk: () => void } {
  const askKey = useMemo(() => nativeChatAskDismissKey(args.ask), [args.ask])
  const detectedPromptKey = useMemo(
    () => nativeChatAskDismissKey(args.detectedAsk),
    [args.detectedAsk]
  )
  const { showPrompt, dismissPrompt } = useMobileNativeChatPromptDismiss({
    ...args,
    kind: 'ask',
    promptKey: askKey,
    detectedPromptKey
  })
  return { askKey, showAsk: showPrompt, dismissAsk: dismissPrompt }
}
