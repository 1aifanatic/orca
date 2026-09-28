import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'

export type DaemonProvider = DaemonPtyRouter | DaemonPtyAdapter

export function getCurrentDaemonAdapter(provider: DaemonProvider): DaemonPtyAdapter {
  if (provider instanceof DaemonPtyRouter) {
    return provider.getCurrentAdapter()
  }
  return provider
}

export function getLegacyDaemonAdapters(provider: DaemonProvider): DaemonPtyAdapter[] {
  if (provider instanceof DaemonPtyRouter) {
    return [...provider.getLegacyAdapters()]
  }
  return []
}

export function disposeProviderSubscriptionsOnly(provider: DaemonProvider): void {
  if (provider instanceof DaemonPtyRouter) {
    provider.disposeRouterOnly()
  }
}
