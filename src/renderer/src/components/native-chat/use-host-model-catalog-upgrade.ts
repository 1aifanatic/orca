import {
  readAgentSessionUnavailable,
  type AgentSessionUnavailable
} from '../../../../shared/agent-session-availability'
import { useAppStore } from '@/store'
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
  const [accountRevision, setAccountRevision] = useState(0)
  const waitKey = `${structuredAgentSessionHostKey(target)}\u0000${agent}\u0000${sessionId}\u0000${accountRevision}`
  const awaitingListing = useSyncExternalStore(subscribeHostModelListingWaits, () =>
    isHostModelListingWaitInFlight(waitKey)
  )
  const [observation, setObservation] = useState<{
    key: string
    unavailable: AgentSessionUnavailable
  } | null>(null)
  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- The replaceable expiry handle is cleared before rearming and by the returned cleanup.
  useEffect(() => {
    if (!enabled || !optionCatalog || !isAgentSessionHandleProvider(agent)) {
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
    const read = (waitForListing: boolean): Promise<AgentSessionModelCatalogResult> =>
      callStructuredAgentSession<AgentSessionModelCatalogResult>(
        target,
        'agentSession.modelCatalog',
        waitForListing ? { ...params, waitForListing } : params
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
    let leave: (() => void) | null = null
    const waitForListing = (requestGeneration: number): void => {
      leave?.()
      leave = joinHostModelListingWait(
        waitKey,
        () => read(true),
        (catalog) => {
          if (stale || generation !== requestGeneration) {
            return
          }
          apply(catalog)
          // The catalog landed before the host's account check; wait once more for that answer.
          if (catalog?.listingInProgress === true) {
            queueMicrotask(() => {
              if (!stale && generation === requestGeneration) {
                waitForListing(requestGeneration)
              }
            })
          }
        }
      )
    }
    const refresh = (): void => {
      if (stale || document.visibilityState === 'hidden') {
        return
      }
      const requestGeneration = ++generation
      if (isHostModelListingWaitInFlight(waitKey)) {
        waitForListing(requestGeneration)
      } else {
        void read(false)
          .then((catalog) => {
            if (stale || generation !== requestGeneration) {
              return
            }
            apply(catalog)
            if (catalog.listingInProgress === true) {
              waitForListing(requestGeneration)
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
        leave?.()
        clear()
      } else {
        refresh()
      }
    }
    clear()
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      const currentSettings = state.settings
      const oldSettings = previous.settings
      if (
        currentSettings?.activeClaudeManagedAccountId !==
          oldSettings?.activeClaudeManagedAccountId ||
        currentSettings?.activeCodexManagedAccountId !== oldSettings?.activeCodexManagedAccountId ||
        currentSettings?.activeClaudeManagedAccountIdsByRuntime !==
          oldSettings?.activeClaudeManagedAccountIdsByRuntime ||
        currentSettings?.activeCodexManagedAccountIdsByRuntime !==
          oldSettings?.activeCodexManagedAccountIdsByRuntime ||
        currentSettings?.agentDefaultEnv !== oldSettings?.agentDefaultEnv
      ) {
        generation += 1
        clear()
        setAccountRevision((revision) => revision + 1)
      }
      if (
        target.kind !== 'local' &&
        state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId
      ) {
        const contact = runtimeHostContactForEntry(
          state.runtimeStatusByEnvironmentId.get(target.environmentId)
        )
        if (contact.verdict !== 'live') {
          generation += 1
          leave?.()
          clear()
        } else if (
          runtimeHostContactForEntry(
            previous.runtimeStatusByEnvironmentId.get(target.environmentId)
          ).verdict !== 'live'
        ) {
          refresh()
        }
      }
    })
    return () => {
      stale = true
      clearTimeout(expiry)
      leave?.()
      unsubscribe()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [
    activeOptionRecordRef,
    agent,
    enabled,
    fence,
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
    unavailable: enabled && observation?.key === waitKey ? observation.unavailable : null
  }
}
