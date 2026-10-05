import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { LAUNCH_PROMPT_DISCOVERY_BOUND_MS } from './automatic-prompt-turns'

export function createUiPromptTurnActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  let discoveryTimer: ReturnType<typeof setTimeout> | null = null
  let nextSeq = 0

  const settleDiscovery = (): void => {
    if (discoveryTimer !== null) {
      clearTimeout(discoveryTimer)
      discoveryTimer = null
    }
    if (get().launchPromptDiscoveryPending) {
      set({ launchPromptDiscoveryPending: false })
    }
  }

  // Armed lazily so a store nobody asks of runs no timer. Re-reads the deadline when it fires, since
  // the deadline is state and may have moved.
  const armDiscoveryTimer = (): void => {
    if (!get().launchPromptDiscoveryPending || discoveryTimer !== null) {
      return
    }
    discoveryTimer = setTimeout(
      () => {
        discoveryTimer = null
        if (Date.now() >= get().launchPromptDiscoveryDeadline) {
          settleDiscovery()
        } else {
          armDiscoveryTimer()
        }
      },
      Math.max(0, get().launchPromptDiscoveryDeadline - Date.now())
    )
  }

  return {
    automaticPromptRequests: [],
    automaticPromptShownId: null,
    promptBlockingDialogIds: [],
    launchPromptDiscoveryPending: true,
    // Measured from store creation, i.e. renderer boot, so no prompt waits past it whenever it asks.
    launchPromptDiscoveryDeadline: Date.now() + LAUNCH_PROMPT_DISCOVERY_BOUND_MS,
    requestAutomaticPrompt: (id) => {
      if (get().automaticPromptRequests.some((request) => request.id === id)) {
        return
      }
      nextSeq += 1
      set({ automaticPromptRequests: [...get().automaticPromptRequests, { id, seq: nextSeq }] })
      armDiscoveryTimer()
    },
    releaseAutomaticPrompt: (id) => {
      const state = get()
      const requests = state.automaticPromptRequests.filter((request) => request.id !== id)
      if (requests.length === state.automaticPromptRequests.length) {
        return
      }
      set({
        automaticPromptRequests: requests,
        automaticPromptShownId:
          state.automaticPromptShownId === id ? null : state.automaticPromptShownId
      })
    },
    markAutomaticPromptShown: (id) => {
      const state = get()
      if (
        state.automaticPromptShownId === id ||
        !state.automaticPromptRequests.some((request) => request.id === id)
      ) {
        return
      }
      set({ automaticPromptShownId: id })
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
    settleLaunchPromptDiscovery: settleDiscovery
  }
}
