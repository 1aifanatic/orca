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

type AccountSettings = ReturnType<typeof useAppStore.getState>['settings']

/** The account inputs a launch resolves its home from, by value: a re-fetched settings copy with
 *  equal values keeps the key, and a switch or a fresh sign-in changes it. Hashed, since the agent
 *  env can hold secrets. */
function accountKeyOf(settings: AccountSettings): string {
  const text = JSON.stringify([
    settings?.activeClaudeManagedAccountId,
    settings?.activeCodexManagedAccountId,
    settings?.activeClaudeManagedAccountIdsByRuntime,
    settings?.activeCodexManagedAccountIdsByRuntime,
    settings?.agentDefaultEnv,
    settings?.claudeManagedAccounts?.map((account) => [account.id, account.lastAuthenticatedAt]),
    settings?.codexManagedAccounts?.map((account) => [account.id, account.lastAuthenticatedAt])
  ])
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

type CatalogObservation = {
  key: string
  unavailable: AgentSessionUnavailable | null
  accountVerified: boolean
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
  /** Changes when the chat records a start that failed for a sign-in or CLI reason. */
  startFailureKey?: string | null
  activeOptionRecordRef: MutableRefObject<NativeChatSessionOptionRecord>
  updateOptionState: (
    update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
  ) => void
}): {
  awaitingListing: boolean
  unavailable: AgentSessionUnavailable | null
  /** The host re-checked the account after a start failure and found it fine. */
  accountVerified: boolean
} {
  const {
    activeOptionRecordRef,
    agent,
    enabled,
    fence,
    namesDefault,
    optionCatalog,
    sessionId,
    startFailureKey,
    target,
    updateOptionState,
    worktree
  } = args
  const accountKey = useAppStore((state) => accountKeyOf(state.settings))
  // A paired host known out of contact answers nothing; its evidence is unknown until it is back.
  const hostLive = useAppStore((state) => {
    const entry =
      target.kind === 'local'
        ? undefined
        : state.runtimeStatusByEnvironmentId.get(target.environmentId)
    return !entry || runtimeHostContactForEntry(entry).verdict === 'live'
  })
  const waitKey = `${structuredAgentSessionHostKey(target)}\u0000${agent}\u0000${sessionId}\u0000${accountKey}`
  const awaitingListing = useSyncExternalStore(subscribeHostModelListingWaits, () =>
    isHostModelListingWaitInFlight(waitKey)
  )
  const [observation, setObservation] = useState<CatalogObservation | null>(null)
  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- The replaceable expiry handle is cleared before rearming and by the returned cleanup.
  useEffect(() => {
    if (!hostLive) {
      // Out of contact the host's evidence is unknown, never the last thing it said.
      setObservation(null)
      return
    }
    if (!enabled || !optionCatalog || !isAgentSessionHandleProvider(agent)) {
      return
    }
    let stale = false
    let generation = 0
    let expiry: ReturnType<typeof setTimeout> | undefined
    const params = { agent, sessionId, ...(namesDefault && worktree ? { worktree } : {}) }
    const read = (
      wait?: 'waitForListing' | 'waitForAvailability'
    ): Promise<AgentSessionModelCatalogResult> =>
      callStructuredAgentSession<AgentSessionModelCatalogResult>(
        target,
        'agentSession.modelCatalog',
        wait ? { ...params, [wait]: true } : params
      )
    // An answer replaces the last one; nothing clears it before the next answer arrives.
    const apply = (catalog: AgentSessionModelCatalogResult | null): void => {
      clearTimeout(expiry)
      const unavailable = catalog ? readAgentSessionUnavailable(catalog.unavailable) : null
      const accountVerified = !unavailable && catalog?.accountVerified === true
      setObservation((previous) =>
        previous?.key === waitKey &&
        previous.accountVerified === accountVerified &&
        previous.unavailable?.reason === unavailable?.reason &&
        (previous.unavailable?.reason !== 'notSignedIn' ||
          (unavailable?.reason === 'notSignedIn' &&
            previous.unavailable.account === unavailable.account))
          ? previous
          : unavailable || accountVerified
            ? { key: waitKey, unavailable, accountVerified }
            : null
      )
      if (!catalog) {
        return
      }
      if (unavailable) {
        expiry = setTimeout(refresh, unavailable.expiresInMs)
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
              apply(null)
            }
          })
      }
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        generation += 1
        leave()
      } else {
        refresh()
      }
    }
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
    startFailureKey,
    target,
    updateOptionState,
    waitKey,
    worktree
  ])
  const current = enabled && hostLive && observation?.key === waitKey ? observation : null
  return {
    awaitingListing,
    unavailable: current?.unavailable ?? null,
    accountVerified: current?.accountVerified ?? false
  }
}
