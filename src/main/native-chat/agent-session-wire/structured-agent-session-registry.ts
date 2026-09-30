// Where the RPC layer finds the host.
//
// The runtime service is already far past its size budget, so structured
// sessions hang off a module-level slot instead of another field on it — the
// same shape the native-chat RPC methods use to reach their own collaborators.
// Tests install a host with a stub adapter and clear it on teardown.

import type { StructuredAgentSessionHost } from './structured-agent-session-host'

let host: StructuredAgentSessionHost | null = null
const installedListeners = new Set<() => void>()

export function setStructuredAgentSessionHost(next: StructuredAgentSessionHost | null): void {
  const installed = next !== null && host === null
  host = next
  if (installed) {
    for (const listener of installedListeners) {
      listener()
    }
  }
}

/** Called each time a host is installed where there was none: this runtime now holds chats. */
export function onStructuredAgentSessionHostInstalled(listener: () => void): () => void {
  installedListeners.add(listener)
  return () => installedListeners.delete(listener)
}

export function getStructuredAgentSessionHost(): StructuredAgentSessionHost | null {
  return host
}
