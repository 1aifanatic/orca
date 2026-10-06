import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { runtimeHostConnectionStateForEntry } from '@/runtime/runtime-host-connection-state'

/** Asks main for one re-attach of this environment's parked browser host; a no-op when attached. */
export function requestClientHostedBrowserReattach(runtimeEnvironmentId: string): void {
  void window.api.runtimeEnvironments
    .resumeBrowserClientHost?.(runtimeEnvironmentId)
    .catch(() => undefined)
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
  // Why only a known entry: no status yet is "not checked", and that is not evidence of offline.
  const hostOffline = useAppStore((s) => {
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
      requestClientHostedBrowserReattach(runtimeEnvironmentId)
    }
  }, [isActive, runtimeEnvironmentId])
  return { hostOffline, hostName }
}
