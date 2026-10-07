import { readNativeChatRestartOfferAtLaunch } from './native-chat-resume-on-restart-store'
import { readStartupDiscovery } from '../startup/startup-discovery-read'
import { useDialogDisposal } from '../lib/dialog-registry-entry'
import { useEffect, useSyncExternalStore } from 'react'
import { readLocalStructuredAgentSessionsHeld } from '@/runtime/local-structured-chats'
import { useAppStore } from '../store'
import { useDialogRegistry } from '../store/dialog-registry'
import {
  getNativeChatResumeLaunchDecided,
  getNativeChatResumeOnRestartDialogRequest,
  markNativeChatResumeLaunchDecided,
  subscribeNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'

/**
 * Answers this machine's resume startup check once the launch read has decided, so tours (which go
 * after every self-opening dialog) know whether a resume offer is coming. Call it after the offer's
 * own dialog entry, so the offer is queued before the check answers. A machine that holds no chats
 * reads nothing; that is decided as soon as it is known.
 */
export function useNativeChatResumeLaunchDiscovery(offerEnabled: boolean): void {
  const launchDecided = useSyncExternalStore(
    subscribeNativeChatResumeOnRestartDialog,
    getNativeChatResumeLaunchDecided,
    getNativeChatResumeLaunchDecided
  )
  const settingsLoaded = useAppStore((store) => store.settings !== null)
  const persistedUIReady = useAppStore((store) => store.persistedUIReady)
  useDialogDisposal('native-chat-resume-discovery', abandonResumeDiscovery)

  useEffect(() => {
    if (launchDecided) {
      const asked = getNativeChatResumeOnRestartDialogRequest() !== null
      useDialogRegistry
        .getState()
        .settleStartupSource('native-chat-resume', asked ? 'ready' : 'none')
    }
  }, [launchDecided])

  useEffect(() => {
    if (!settingsLoaded && persistedUIReady) {
      abandonResumeDiscovery()
    }
    if (!settingsLoaded || launchDecided) {
      return
    }
    let cancelled = false
    // A runtime that holds a chat turns the offer on instead, and its read decides.
    const read = offerEnabled
      ? readNativeChatRestartOfferAtLaunch().then(() => true)
      : readLocalStructuredAgentSessionsHeld()
    void readStartupDiscovery(read).then((holds) => {
      if (cancelled) {
        return
      }
      if (holds === null) {
        abandonResumeDiscovery()
      } else if (!holds) {
        markNativeChatResumeLaunchDecided()
      }
    })
    return () => {
      cancelled = true
    }
  }, [launchDecided, offerEnabled, persistedUIReady, settingsLoaded])
}

function abandonResumeDiscovery(): void {
  useDialogRegistry.getState().settleStartupSource('native-chat-resume', 'unavailable')
}
