import { useSyncExternalStore } from 'react'

// Main's verdict per environment: this desktop's browser host is holding its pages for the runtime.
const parkedEnvironmentIds = new Set<string>()
const listeners = new Set<() => void>()
let mainSubscription: (() => void) | null = null

export function setBrowserClientHostParked(environmentId: string, parked: boolean): void {
  if (parkedEnvironmentIds.has(environmentId) === parked) {
    return
  }
  if (parked) {
    parkedEnvironmentIds.add(environmentId)
  } else {
    parkedEnvironmentIds.delete(environmentId)
  }
  for (const listener of listeners) {
    listener()
  }
}

/** One re-attach if parked; the answer also re-syncs a renderer that missed the push. */
export async function resumeBrowserClientHost(environmentId: string): Promise<void> {
  const parked = await window.api.runtimeEnvironments
    .resumeBrowserClientHost?.({ selector: environmentId })
    .catch(() => null)
  if (typeof parked === 'boolean') {
    setBrowserClientHostParked(environmentId, parked)
  }
}

function subscribe(listener: () => void): () => void {
  mainSubscription ??=
    window.api.runtimeEnvironments.onBrowserClientHostParked?.((event) =>
      setBrowserClientHostParked(event.environmentId, event.parked)
    ) ?? null
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useBrowserClientHostParked(environmentId: string): boolean {
  return useSyncExternalStore(subscribe, () => parkedEnvironmentIds.has(environmentId))
}

export function resetBrowserClientHostParkedForTests(): void {
  mainSubscription?.()
  mainSubscription = null
  parkedEnvironmentIds.clear()
  listeners.clear()
}
