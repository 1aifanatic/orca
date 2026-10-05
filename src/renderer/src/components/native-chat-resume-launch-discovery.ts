import { useEffect, useSyncExternalStore } from 'react'
import { readLocalStructuredAgentSessionsHeld } from '@/runtime/local-structured-chats'
import { useAppStore } from '../store'
import {
  getNativeChatResumeLaunchDecided,
  markNativeChatResumeLaunchDecided,
  subscribeNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'

/**
 * Tells the dialogs that open by themselves when this machine's resume read has started and when it
 * has decided, so the resume offer goes first. A machine that holds no chats reads nothing; that is
 * decided as soon as it is known, so the wait never depends on some other prompt asking for a turn.
 */
export function useNativeChatResumeLaunchDiscovery(offerEnabled: boolean): void {
  const launchDecided = useSyncExternalStore(
    subscribeNativeChatResumeOnRestartDialog,
    getNativeChatResumeLaunchDecided,
    getNativeChatResumeLaunchDecided
  )
  const settingsLoaded = useAppStore((store) => store.settings !== null)
  const beginLaunchPromptDiscovery = useAppStore((store) => store.beginLaunchPromptDiscovery)
  const settleLaunchPromptDiscovery = useAppStore((store) => store.settleLaunchPromptDiscovery)

  useEffect(() => {
    // The read starts with the offer once enabled; the wait's bound runs from here.
    if (offerEnabled) {
      beginLaunchPromptDiscovery()
    }
  }, [offerEnabled, beginLaunchPromptDiscovery])

  useEffect(() => {
    if (launchDecided) {
      settleLaunchPromptDiscovery()
    }
  }, [launchDecided, settleLaunchPromptDiscovery])

  useEffect(() => {
    if (offerEnabled || !settingsLoaded || launchDecided) {
      return
    }
    let cancelled = false
    // A runtime that holds a chat turns the offer on instead, and its read decides.
    void readLocalStructuredAgentSessionsHeld().then((holds) => {
      if (!cancelled && !holds) {
        markNativeChatResumeLaunchDecided()
      }
    })
    return () => {
      cancelled = true
    }
  }, [launchDecided, offerEnabled, settingsLoaded])
}
