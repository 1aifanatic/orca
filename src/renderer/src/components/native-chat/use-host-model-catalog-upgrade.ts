import {
  readAgentSessionUnavailable,
  type AgentSessionUnavailable
} from '../../../../shared/agent-session-availability'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { runtimeHostContactForEntry } from '../../../../shared/runtime-host-contact'
import { useEffect, useState, useSyncExternalStore, type MutableRefObject } from 'react'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'
import type { NativeChatSessionOptionRecord } from '../../../../shared/native-chat-session-option-state'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import {
  isHostModelListingWaitInFlight,
  joinHostModelListingWait,
  subscribeHostModelListingWaits
} from './host-model-listing-waits'

// Each account switch gets its own wait slot, so a switch never joins the old account's read
// while every mount under the same accounts still joins the one in flight.
let lastAccountInputs: readonly unknown[] = []
let accountRevision = 0

function accountRevisionOf(inputs: readonly unknown[]): number {
  if (
    inputs.length !== lastAccountInputs.length ||
    inputs.some((input, index) => input !== lastAccountInputs[index])
  ) {
    lastAccountInputs = inputs
    accountRevision += 1
  }
  return accountRevision
}

/**
 * Upgrades the static seed with the host's stored catalog without waiting on
 * attach. A record-less read (no session yet) resolves the account a launch
 * would pin, so the picker warms during create. An older host answers
 * `forbidden` or `method_not_found` — both mean "no such surface", so the seed
 * stands until the live read lands.
 *
 * When the host says its first listing for the account is running, one more
 * read waits for it — one per chat, joined by every later run and remount.
 * Reports that wait alongside the host's short-lived availability evidence.
 */
export function useHostModelCatalogUpgrade(args: {
  agent: AgentType
  sessionId: string
  target: RuntimeClientTarget
  optionCatalog: AgentSessionOptionCatalog | null
  /** The pane is on screen: a read can start a listing process, so hidden restored tabs must not. */
  enabled: boolean
  /** A launch runs the CLI default when nothing is seeded; a reopened session may not. */
  namesDefault: boolean
  /** Where the launch runs: the host names no default its config could replace. */
  worktree?: string
  fence: number | null
  activeOptionRecordRef: MutableRefObject<NativeChatSessionOptionRecord>
  updateOptionState: (
    update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
  ) => void
}): { awaitingListing: boolean; unavailable: AgentSessionUnavailable | null } {
  const {
    activeOptionRecordRef,
    agent,
    enabled,
    fence,
    namesDefault,
    optionCatalog,
    sessionId,
    target,
    updateOptionState,
    worktree
  } = args
  const accountInputs = useAppStore(
    useShallow((state) => [
      state.settings?.activeClaudeManagedAccountId,
      state.settings?.activeCodexManagedAccountId,
      state.settings?.activeClaudeManagedAccountIdsByRuntime,
      state.settings?.activeCodexManagedAccountIdsByRuntime,
      state.settings?.agentDefaultEnv
    ])
  )
  // A paired host known out of contact answers nothing; its evidence is unknown until it is back.
  const hostLive = useAppStore((state) => {
    const entry =
      target.kind === 'local'
        ? undefined
        : state.runtimeStatusByEnvironmentId.get(target.environmentId)
    return !entry || runtimeHostContactForEntry(entry).verdict === 'live'
  })
  const waitKey = `${structuredAgentSessionHostKey(target)}\u0000${agent}\u0000${sessionId}\u0000${accountRevisionOf(accountInputs)}`
  const awaitingListing = useSyncExternalStore(subscribeHostModelListingWaits, () =>
    isHostModelListingWaitInFlight(waitKey)
  )
  const [observation, setObservation] = useState<{
    key: string
    unavailable: AgentSessionUnavailable
  } | null>(null)
  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- The replaceable expiry handle is cleared before rearming and by the returned cleanup.
  useEffect(() => {
    if (!enabled || !hostLive || !optionCatalog || !isAgentSessionHandleProvider(agent)) {
      return
    }
    let stale = false
    let generation = 0
    let expiry: ReturnType<typeof setTimeout> | undefined
    const clear = (): void => {
      clearTimeout(expiry)
      setObservation(null)
    }
    const params = { agent, sessionId, ...(namesDefault && worktree ? { worktree } : {}) }
    const read = (
      wait?: 'waitForListing' | 'waitForAvailability'
    ): Promise<AgentSessionModelCatalogResult> =>
      callStructuredAgentSession<AgentSessionModelCatalogResult>(
        target,
        'agentSession.modelCatalog',
        wait ? { ...params, [wait]: true } : params
      )
    const apply = (catalog: AgentSessionModelCatalogResult | null): void => {
      clear()
      if (!catalog) {
        return
      }
      const unavailable = readAgentSessionUnavailable(catalog.unavailable)
      if (unavailable) {
        setObservation({ key: waitKey, unavailable })
        expiry = setTimeout(() => {
          clear()
          refresh()
        }, unavailable.expiresInMs)
      }
      updateOptionState((current) =>
        current.record === activeOptionRecordRef.current
          ? applyStructuredAgentSessionModelCatalog(current, optionCatalog, catalog, {
              namesDefault
            })
          : current
      )
    }
    const leaves = new Set<() => void>()
    const leave = (): void => {
      for (const leaveWait of leaves) {
        leaveWait()
      }
      leaves.clear()
    }
    // One waiting read of each kind per chat; a probe verdict is never followed up again.
    const waitFor = (
      wait: 'waitForListing' | 'waitForAvailability',
      requestGeneration: number
    ): void => {
      leaves.add(
        joinHostModelListingWait(
          wait === 'waitForListing' ? waitKey : `${waitKey}\u0000availability`,
          () => read(wait),
          (catalog) => {
            if (stale || generation !== requestGeneration) {
              return
            }
            apply(catalog)
            // The catalog landed before the probe's verdict; one more read waits for that.
            if (wait === 'waitForListing' && catalog?.listingInProgress === true) {
              queueMicrotask(() => {
                if (!stale && generation === requestGeneration) {
                  waitFor('waitForAvailability', requestGeneration)
                }
              })
            }
          }
        )
      )
    }
    const refresh = (): void => {
      if (stale || document.visibilityState === 'hidden') {
        return
      }
      const requestGeneration = ++generation
      if (isHostModelListingWaitInFlight(waitKey)) {
        waitFor('waitForListing', requestGeneration)
      } else {
        void read()
          .then((catalog) => {
            if (stale || generation !== requestGeneration) {
              return
            }
            apply(catalog)
            if (catalog.listingInProgress === true) {
              // Only a host that reports the listing knows the wait params; an older one refuses them.
              waitFor(
                catalog.origin === 'unknown' ? 'waitForListing' : 'waitForAvailability',
                requestGeneration
              )
            }
          })
          .catch(() => {
            if (!stale && generation === requestGeneration) {
              clear()
            }
          })
      }
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        generation += 1
        leave()
        clear()
      } else {
        refresh()
      }
    }
    clear()
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stale = true
      clearTimeout(expiry)
      leave()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [
    activeOptionRecordRef,
    agent,
    enabled,
    fence,
    hostLive,
    namesDefault,
    optionCatalog,
    sessionId,
    target,
    updateOptionState,
    waitKey,
    worktree
  ])
  return {
    awaitingListing,
    unavailable:
      enabled && hostLive && observation?.key === waitKey ? observation.unavailable : null
  }
}
