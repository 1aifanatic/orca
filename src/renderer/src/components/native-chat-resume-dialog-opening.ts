import { useEffect, useSyncExternalStore } from 'react'
import { useNativeChatRestartOfferEnabled } from './native-chat-restart-offer-gate'
import {
  getNativeChatResumeOnRestartDialogRequest,
  setNativeChatResumeDialogShowing,
  subscribeNativeChatResumeOnRestartDialog,
  type NativeChatResumeOnRestartDialogRequest
} from './native-chat-resume-on-restart-dialog'
import { dismissReconnectRestartOffers } from './native-chat-restart-reconnect-toast'
import { useNativeChatRestartOffers } from './native-chat-resume-on-restart-store'
import { useMachineViews, type MachineView } from './native-chat-resume-machine-views'
import {
  markNativeChatRestartOffersShown,
  useNativeChatRestartOfferSources
} from './native-chat-restart-offer-triggers'

/**
 * Whether the resume dialog is on screen, and over which machines. Starts every source of offers
 * and records what the dialog shows as decided.
 */
export function useNativeChatResumeDialogOpening(): {
  machines: MachineView[]
  request: NativeChatResumeOnRestartDialogRequest | null
  showing: boolean
} {
  const localEnabled = useNativeChatRestartOfferEnabled()
  useNativeChatRestartOfferSources(localEnabled)
  const offers = useNativeChatRestartOffers()
  const machines = useMachineViews(offers)
  // Open is an external request, never mirrored into local state: the launch load, the status-bar
  // entry and a reconnect toast all raise it, and a copy here would go stale against the last one.
  const request = useSyncExternalStore(
    subscribeNativeChatResumeOnRestartDialog,
    getNativeChatResumeOnRestartDialogRequest,
    getNativeChatResumeOnRestartDialogRequest
  )
  // What the open dialog shows is decided: a later read of a paired server does not announce it,
  // and a restart toast still up goes, since the dialog lists its chats and blocks clicks on it.
  const showing = request !== null && machines.length > 0
  useEffect(() => {
    setNativeChatResumeDialogShowing(showing)
    return () => setNativeChatResumeDialogShowing(false)
  }, [showing])
  useEffect(() => {
    if (!showing) {
      return
    }
    markNativeChatRestartOffersShown(
      machines.map((machine) => ({
        machine: machine.machine,
        candidates: machine.offer.candidates
      }))
    )
    dismissReconnectRestartOffers(machines.map((machine) => machine.machine))
  }, [showing, machines])
  return { machines, request, showing }
}
