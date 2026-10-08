import type { PairingOffer } from '../../../shared/pairing'
import type { RuntimeEnvironmentSource } from '../../../shared/runtime-environments'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

/** A configured server the desktop can relay to. */
export type MobileDesktopRelayHost = {
  environmentId: string
  // Pairing revision and runtime identity; delegated grants from another fence are never reused.
  fence: string
  // The desktop's own runtime-scope pairing; the relay swaps in a phone's delegated token.
  pairing: PairingOffer
}

/** A configured server as the desktop's sidebar sees it, without contacting it. */
export type MobileDesktopRelayHostListing = {
  id: string
  name: string
  source?: RuntimeEnvironmentSource
  orcadDeployment?: { sshTargetId: string } | null
  fence: string
}

/** The desktop's configured servers, as the relay sees them. */
export type MobileDesktopRelayHosts = {
  /** Every configured server, with the desktop's own last status for those it has one for. */
  list: () => {
    environments: MobileDesktopRelayHostListing[]
    statusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
  }
  /** Null when the id names no configured server; a phone-supplied endpoint is never used. */
  resolve: (environmentId: string) => Promise<MobileDesktopRelayHost | null>
  /** A call as the desktop itself, over its own connection to the server. */
  call: (
    host: MobileDesktopRelayHost,
    method: string,
    params: unknown
  ) => Promise<RuntimeRpcResponse<unknown>>
  /** Fires when a server is removed, re-paired or disconnected; returns an unsubscribe. */
  onEnvironmentRetired: (listener: (environmentId: string) => void) => () => void
}
