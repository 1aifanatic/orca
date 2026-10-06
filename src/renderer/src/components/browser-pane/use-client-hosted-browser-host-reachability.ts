import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { runtimeHostConnectionStateForEntry } from '@/runtime/runtime-host-connection-state'
import {
  resumeBrowserClientHost,
  useBrowserClientHostParked
} from '@/runtime/browser-client-host-parked-environments'

/** Retries the host connection now, and re-attaches this environment's browser host if parked. */
export function requestClientHostedBrowserReconnect(runtimeEnvironmentId: string): void {
  void window.api.runtimeEnvironments
    .retryControlConnection?.({ selector: runtimeEnvironmentId })
    .catch(() => undefined)
  void resumeBrowserClientHost(runtimeEnvironmentId)
}

/**
 * Whether the host behind a client-hosted page can be reached, and its display name. Opening the
 * tab is one of the real events that asks a parked host to re-attach.
 */
export function useClientHostedBrowserHostReachability({
  runtimeEnvironmentId,
  isActive
}: {
  runtimeEnvironmentId: string
  isActive: boolean
}): { hostOffline: boolean; hostName: string | null } {
  // Why both: parked is main's own verdict even while the control link is up; an unreachable control
  // link still explains a missing guest when no browser host was ever started to park.
  const parked = useBrowserClientHostParked(runtimeEnvironmentId)
  // Why only a known entry: no status yet is "not checked", and that is not evidence of offline.
  const controlOffline = useAppStore((s) => {
    const entry = s.runtimeStatusByEnvironmentId.get(runtimeEnvironmentId)
    const state = runtimeHostConnectionStateForEntry(entry)
    return entry !== undefined && (state === 'reconnecting' || state === 'disconnected')
  })
  const hostName = useAppStore(
    (s) =>
      s.runtimeEnvironments.find((environment) => environment.id === runtimeEnvironmentId)?.name ??
      null
  )
  useEffect(() => {
    if (isActive) {
      void resumeBrowserClientHost(runtimeEnvironmentId)
    }
  }, [isActive, runtimeEnvironmentId])
  return { hostOffline: parked || controlOffline, hostName }
}
