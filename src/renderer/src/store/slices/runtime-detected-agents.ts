import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { callRuntimeRpc, RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import {
  captureRuntimeAgentDetectionOwner,
  runtimeAgentDetectionCacheMatchesOwner,
  runtimeAgentDetectionOwnerIsCurrent,
  runtimeAgentDetectionOwnerKey,
  type RuntimeAgentDetectionOwner
} from '@/runtime/runtime-agent-detection-owner'

// Why: remote runtime hosts are not SSH connections, but their launch surfaces
// (tab bar, quick launch, Settings → Agents under an Active Server) still have
// to probe the host where the workspace actually runs.
export type RuntimeDetectedAgentsSlice = {
  runtimeDetectedAgentIds: Record<string, TuiAgent[] | null>
  runtimeDetectedAgentOwnerKeys: Record<string, string>
  isDetectingRuntimeAgents: Record<string, boolean>
  isRefreshingRuntimeAgents: Record<string, boolean>
  ensureRuntimeDetectedAgents: (
    environmentId: string,
    expectedPairingRevision?: number
  ) => Promise<TuiAgent[]>
  /** Forces a re-detect on the runtime host via `preflight.refreshAgents`
   *  (login-shell PATH re-read), falling back to `preflight.detectAgents` for
   *  servers that predate the refresh RPC. */
  refreshRuntimeDetectedAgents: (
    environmentId: string,
    expectedPairingRevision?: number
  ) => Promise<TuiAgent[]>
  clearRuntimeDetectedAgents: (environmentId: string) => void
  /** Drops runtime detected-agent caches for environments not in the kept set.
   *  Wired into setRuntimeEnvironments so removed environments don't leak their
   *  detected-agent entries for the renderer session. */
  retainRuntimeDetectedAgents: (environmentIds: Iterable<string>) => void
}

// Why: these are module-scoped (not in the store) so we can deduplicate
// concurrent callers without storing a Promise in Zustand state.
type PendingDetection = { owner: RuntimeAgentDetectionOwner; promise: Promise<TuiAgent[]> }
const runtimeDetectPromises = new Map<string, PendingDetection>()
const runtimeRefreshPromises = new Map<string, PendingDetection>()

function isRuntimeMethodNotFoundError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}

export function _getRuntimeDetectPromiseCountForTest(): number {
  return runtimeDetectPromises.size
}

export const createRuntimeDetectedAgentsSlice: StateCreator<
  AppState,
  [],
  [],
  RuntimeDetectedAgentsSlice
> = (set, get) => ({
  runtimeDetectedAgentIds: {},
  runtimeDetectedAgentOwnerKeys: {},
  isDetectingRuntimeAgents: {},
  isRefreshingRuntimeAgents: {},

  ensureRuntimeDetectedAgents: (environmentId, expectedPairingRevision) => {
    const owner = captureRuntimeAgentDetectionOwner(
      get().runtimeEnvironments,
      environmentId,
      expectedPairingRevision
    )
    const ownerKey = runtimeAgentDetectionOwnerKey(owner)
    const isCurrent = () => runtimeAgentDetectionOwnerIsCurrent(get().runtimeEnvironments, owner)
    if (!isCurrent()) {
      return Promise.resolve([])
    }
    const inflightRefresh = runtimeRefreshPromises.get(ownerKey)
    if (inflightRefresh) {
      return inflightRefresh.promise
    }
    const existing = runtimeAgentDetectionCacheMatchesOwner(
      get().runtimeDetectedAgentOwnerKeys,
      owner
    )
      ? get().runtimeDetectedAgentIds[environmentId]
      : null
    // Why: an empty result ([]) is truthy, so a prior "no agents found" detection
    // must not be treated as cached — re-detect so a later install / PATH fix is
    // picked up without a reconnect. Non-empty results still short-circuit.
    if (existing?.length) {
      return Promise.resolve(existing)
    }
    const inflight = runtimeDetectPromises.get(ownerKey)
    if (inflight) {
      return inflight.promise
    }

    set((s) => ({
      runtimeDetectedAgentIds: { ...s.runtimeDetectedAgentIds, [environmentId]: null },
      runtimeDetectedAgentOwnerKeys: {
        ...s.runtimeDetectedAgentOwnerKeys,
        [environmentId]: ownerKey
      },
      isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [environmentId]: true }
    }))

    const pending = callRuntimeRpc<TuiAgent[]>(
      { kind: 'environment', environmentId },
      'preflight.detectAgents',
      undefined,
      { expectedEnvironmentPairingRevision: owner.pairingRevision }
    )
      .then((ids) => {
        // Why: skip committing if the environment was removed (retained out)
        // while the detect was in flight — otherwise it re-adds a stale entry
        // that retainRuntimeDetectedAgents just pruned.
        if (isCurrent() && runtimeDetectPromises.get(ownerKey)?.promise === pending) {
          set((s) => ({
            runtimeDetectedAgentIds: { ...s.runtimeDetectedAgentIds, [environmentId]: ids },
            isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [environmentId]: false }
          }))
        }
        return isCurrent() ? ids : []
      })
      .catch(() => {
        // Why: a remote runtime may be disconnected or version-incompatible.
        // Keep the menu retryable instead of pinning a failed probe forever.
        // Same in-flight guard as the .then() above: if the environment was
        // retained out mid-detect, don't re-add the isDetecting entry that
        // retainRuntimeDetectedAgents just pruned (and don't clobber a freshly
        // started detect's spinner).
        if (isCurrent() && runtimeDetectPromises.get(ownerKey)?.promise === pending) {
          set((s) => ({
            isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [environmentId]: false }
          }))
        }
        return []
      })
      .finally(() => {
        if (runtimeDetectPromises.get(ownerKey)?.promise === pending) {
          runtimeDetectPromises.delete(ownerKey)
        }
      })

    runtimeDetectPromises.set(ownerKey, { owner, promise: pending })
    return pending
  },

  refreshRuntimeDetectedAgents: (environmentId, expectedPairingRevision) => {
    const owner = captureRuntimeAgentDetectionOwner(
      get().runtimeEnvironments,
      environmentId,
      expectedPairingRevision
    )
    const ownerKey = runtimeAgentDetectionOwnerKey(owner)
    const isCurrent = () => runtimeAgentDetectionOwnerIsCurrent(get().runtimeEnvironments, owner)
    if (!isCurrent()) {
      return Promise.resolve([])
    }
    const inflight = runtimeRefreshPromises.get(ownerKey)
    if (inflight) {
      return inflight.promise
    }

    // Why: a refresh is newer and authoritative; detach an older detect so its
    // late result cannot overwrite the freshly hydrated PATH result.
    runtimeDetectPromises.delete(ownerKey)
    set((s) => ({
      runtimeDetectedAgentIds: {
        ...s.runtimeDetectedAgentIds,
        [environmentId]: runtimeAgentDetectionCacheMatchesOwner(
          s.runtimeDetectedAgentOwnerKeys,
          owner
        )
          ? (s.runtimeDetectedAgentIds[environmentId] ?? null)
          : null
      },
      runtimeDetectedAgentOwnerKeys: {
        ...s.runtimeDetectedAgentOwnerKeys,
        [environmentId]: ownerKey
      },
      isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [environmentId]: true }
    }))

    const pending = callRuntimeRpc<{ agents: TuiAgent[] }>(
      { kind: 'environment', environmentId },
      'preflight.refreshAgents',
      undefined,
      { expectedEnvironmentPairingRevision: owner.pairingRevision }
    )
      .then((result) => result.agents)
      .catch((error) => {
        if (!isRuntimeMethodNotFoundError(error) || !isCurrent()) {
          throw error
        }
        // Why: only older servers need the fallback; retrying disconnects and
        // runtime failures doubles remote work without any chance of recovery.
        return callRuntimeRpc<TuiAgent[]>(
          { kind: 'environment', environmentId },
          'preflight.detectAgents',
          undefined,
          { expectedEnvironmentPairingRevision: owner.pairingRevision }
        )
      })
      .then((ids) => {
        // Why: same guard as ensureRuntimeDetectedAgents — if the environment
        // was retained out mid-refresh, don't re-add a pruned entry.
        if (isCurrent() && runtimeRefreshPromises.get(ownerKey)?.promise === pending) {
          set((s) => ({
            runtimeDetectedAgentIds: { ...s.runtimeDetectedAgentIds, [environmentId]: ids },
            isDetectingRuntimeAgents: {
              ...s.isDetectingRuntimeAgents,
              [environmentId]: false
            },
            isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [environmentId]: false }
          }))
        }
        return isCurrent() ? ids : []
      })
      .catch(() => {
        // Why: a disconnected runtime must keep Refresh retryable and must not
        // wipe the last known agent list.
        if (isCurrent() && runtimeRefreshPromises.get(ownerKey)?.promise === pending) {
          set((s) => ({
            isDetectingRuntimeAgents: {
              ...s.isDetectingRuntimeAgents,
              [environmentId]: false
            },
            isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [environmentId]: false }
          }))
        }
        return isCurrent() ? (get().runtimeDetectedAgentIds[environmentId] ?? []) : []
      })
      .finally(() => {
        if (runtimeRefreshPromises.get(ownerKey)?.promise === pending) {
          runtimeRefreshPromises.delete(ownerKey)
        }
      })

    runtimeRefreshPromises.set(ownerKey, { owner, promise: pending })
    return pending
  },

  clearRuntimeDetectedAgents: (environmentId: string) => {
    for (const pendingByOwner of [runtimeDetectPromises, runtimeRefreshPromises]) {
      for (const [key, pending] of pendingByOwner) {
        if (pending.owner.environmentId === environmentId) {
          pendingByOwner.delete(key)
        }
      }
    }
    set((s) => {
      const { [environmentId]: _, ...restAgents } = s.runtimeDetectedAgentIds
      const { [environmentId]: __, ...restLoading } = s.isDetectingRuntimeAgents
      const { [environmentId]: ___, ...restRefreshing } = s.isRefreshingRuntimeAgents
      const { [environmentId]: ____, ...restOwners } = s.runtimeDetectedAgentOwnerKeys
      return {
        runtimeDetectedAgentIds: restAgents,
        runtimeDetectedAgentOwnerKeys: restOwners,
        isDetectingRuntimeAgents: restLoading,
        isRefreshingRuntimeAgents: restRefreshing
      }
    })
  },

  retainRuntimeDetectedAgents: (environmentIds: Iterable<string>) => {
    const keep = new Set(environmentIds)
    for (const pendingByOwner of [runtimeDetectPromises, runtimeRefreshPromises]) {
      for (const [key, pending] of pendingByOwner) {
        if (!keep.has(pending.owner.environmentId)) {
          pendingByOwner.delete(key)
        }
      }
    }
    set((s) => {
      let changed = false
      const nextAgents = { ...s.runtimeDetectedAgentIds }
      const nextLoading = { ...s.isDetectingRuntimeAgents }
      const nextRefreshing = { ...s.isRefreshingRuntimeAgents }
      const nextOwners = { ...s.runtimeDetectedAgentOwnerKeys }
      for (const id of Object.keys(nextAgents)) {
        if (!keep.has(id)) {
          delete nextAgents[id]
          changed = true
        }
      }
      for (const id of Object.keys(nextLoading)) {
        if (!keep.has(id)) {
          delete nextLoading[id]
          changed = true
        }
      }
      for (const id of Object.keys(nextRefreshing)) {
        if (!keep.has(id)) {
          delete nextRefreshing[id]
          changed = true
        }
      }
      for (const id of Object.keys(nextOwners)) {
        if (!keep.has(id)) {
          delete nextOwners[id]
          changed = true
        }
      }
      return changed
        ? {
            runtimeDetectedAgentIds: nextAgents,
            runtimeDetectedAgentOwnerKeys: nextOwners,
            isDetectingRuntimeAgents: nextLoading,
            isRefreshingRuntimeAgents: nextRefreshing
          }
        : s
    })
  }
})
