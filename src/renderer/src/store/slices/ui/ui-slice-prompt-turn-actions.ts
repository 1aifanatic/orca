import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import {
  LAUNCH_PROMPT_DISCOVERY_BACKSTOP_MS,
  LAUNCH_PROMPT_DISCOVERY_BOUND_MS
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

  return {
    automaticPromptRequests: [],
    automaticPromptShownId: null,
    promptBlockingDialogIds: [],
    launchPromptDiscoveryPending: true,
    launchPromptDiscoveryDeadline: Date.now() + LAUNCH_PROMPT_DISCOVERY_BACKSTOP_MS,
    requestAutomaticPrompt: (id) => {
      if (get().automaticPromptRequests.some((request) => request.id === id)) {
        return
      }
      nextSeq += 1
      set({ automaticPromptRequests: [...get().automaticPromptRequests, { id, seq: nextSeq }] })
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
