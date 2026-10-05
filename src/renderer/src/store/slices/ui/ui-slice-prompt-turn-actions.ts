import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { isOtherDialogOpen, subscribeDialogPresence } from '@/lib/dialog-presence'
import {
  LAUNCH_PROMPT_DISCOVERY_BACKSTOP_MS,
  LAUNCH_PROMPT_DISCOVERY_BOUND_MS,
  selectVisibleAutomaticPrompt
} from './automatic-prompt-turns'

export function createUiPromptTurnActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  let discoveryTimer: ReturnType<typeof setTimeout> | null = null
  let nextSeq = 0
  let discoveryBegun = false

  const settleDiscovery = (): void => {
    if (discoveryTimer !== null) {
      clearTimeout(discoveryTimer)
      discoveryTimer = null
    }
    if (get().launchPromptDiscoveryPending) {
      set({ launchPromptDiscoveryPending: false })
    }
  }

  // Re-reads the deadline when it fires, since the deadline is state and may have moved.
  const onDiscoveryTimer = (): void => {
    discoveryTimer = null
    const { launchPromptDiscoveryPending, launchPromptDiscoveryDeadline } = get()
    if (!launchPromptDiscoveryPending) {
      return
    }
    if (Date.now() >= launchPromptDiscoveryDeadline) {
      settleDiscovery()
      return
    }
    discoveryTimer = setTimeout(onDiscoveryTimer, launchPromptDiscoveryDeadline - Date.now())
  }
  // Armed at boot, never by a request: the wait must end even when no prompt ever asks for a turn,
  // or tours would never start.
  discoveryTimer = setTimeout(onDiscoveryTimer, LAUNCH_PROMPT_DISCOVERY_BACKSTOP_MS)
  // The store is created once per window, so this subscription lives as long as the presence set.
  subscribeDialogPresence(() => {
    const open = isOtherDialogOpen()
    if (get().otherDialogOnScreen !== open) {
      set({ otherDialogOnScreen: open })
    }
  })

  return {
    automaticPromptRequests: [],
    promptBlockingDialogIds: [],
    otherDialogOnScreen: isOtherDialogOpen(),
    launchPromptDiscoveryPending: true,
    launchPromptDiscoveryDeadline: Date.now() + LAUNCH_PROMPT_DISCOVERY_BACKSTOP_MS,
    requestAutomaticPrompt: (id, key = null) => {
      const requests = get().automaticPromptRequests
      const existing = requests.find((request) => request.id === id)
      if (existing?.key === key) {
        return
      }
      nextSeq += 1
      // A new key is the owner's next item: it replaces the last in place and is not yet shown.
      const request = { id, key, seq: nextSeq, shown: false }
      set({
        automaticPromptRequests: existing
          ? requests.map((entry) => (entry === existing ? request : entry))
          : [...requests, request]
      })
    },
    releaseAutomaticPrompt: (id, key = null) => {
      const requests = get().automaticPromptRequests
      const remaining = requests.filter((request) => request.id !== id || request.key !== key)
      if (remaining.length !== requests.length) {
        set({ automaticPromptRequests: remaining })
      }
    },
    markAutomaticPromptShown: (id, key = null) => {
      const visible = selectVisibleAutomaticPrompt(get())
      // Only the item whose turn it is can be on screen; anything else is a stale call.
      if (visible === null || visible.id !== id || visible.key !== key || visible.shown) {
        return
      }
      set({
        automaticPromptRequests: get().automaticPromptRequests.map((request) =>
          request === visible ? { ...request, shown: true } : request
        )
      })
    },
    setPromptBlockingDialogVisible: (id, visible) => {
      const ids = get().promptBlockingDialogIds
      if (ids.includes(id) === visible) {
        return
      }
      set({
        promptBlockingDialogIds: visible ? [...ids, id] : ids.filter((entry) => entry !== id)
      })
    },
    beginLaunchPromptDiscovery: () => {
      if (!get().launchPromptDiscoveryPending || discoveryBegun) {
        return
      }
      discoveryBegun = true
      const deadline = Date.now() + LAUNCH_PROMPT_DISCOVERY_BOUND_MS
      set({ launchPromptDiscoveryDeadline: deadline })
      if (discoveryTimer !== null) {
        clearTimeout(discoveryTimer)
      }
      discoveryTimer = setTimeout(onDiscoveryTimer, LAUNCH_PROMPT_DISCOVERY_BOUND_MS)
    },
    settleLaunchPromptDiscovery: settleDiscovery
  }
}
