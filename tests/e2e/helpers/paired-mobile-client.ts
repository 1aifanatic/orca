import type { Page } from '@stablyai/playwright-test'
import { MOBILE_RUNTIME_CLIENT_CAPABILITIES } from '../../../mobile/src/transport/mobile-runtime-client-capabilities'
import { decodePairingOffer, type PairingOffer } from '../../../src/shared/pairing'
import {
  sendRemoteRuntimeRequest,
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription,
  type RemoteRuntimeSubscriptionCallbacks
} from '../../../src/shared/remote-runtime-client'
import type { RuntimeRpcResponse } from '../../../src/shared/runtime-rpc-envelope'

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * A phone paired to one runtime: the mobile-scoped device token and the phone app's own
 * capability list, over the same E2EE transport the app uses.
 */
export type PairedMobileClient = {
  pairing: PairingOffer
  /** Raw response, for asserting a refusal. */
  request: <T>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ) => Promise<RuntimeRpcResponse<T>>
  /** Result of a call that must succeed; throws with the host's error code otherwise. */
  call: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>
  subscribe: <T>(
    method: string,
    params: unknown,
    callbacks: RemoteRuntimeSubscriptionCallbacks<T>,
    timeoutMs?: number
  ) => Promise<RemoteRuntimeSubscription>
  /** Closes every subscription this client opened. */
  dispose: () => void
}

export function pairMobileClient(offer: { pairingUrl: string }): PairedMobileClient {
  const pairing = decodePairingOffer(offer.pairingUrl)
  // Why: a runtime-scope token skips the mobile allowlist, so the oracle would not be a phone.
  if (pairing.scope !== 'mobile') {
    throw new Error(`Expected a mobile-scoped pairing offer, got scope ${String(pairing.scope)}`)
  }
  const capabilities = [...MOBILE_RUNTIME_CLIENT_CAPABILITIES]
  const open = new Set<RemoteRuntimeSubscription>()
  const request = <T>(
    method: string,
    params: unknown = {},
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<RuntimeRpcResponse<T>> =>
    sendRemoteRuntimeRequest<T>(
      pairing,
      method,
      params,
      timeoutMs,
      undefined,
      undefined,
      capabilities
    )
  return {
    pairing,
    request,
    call: async <T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> => {
      const response = await request<T>(method, params, timeoutMs)
      if (!response.ok) {
        throw new Error(`${method} failed: ${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    subscribe: async (method, params, callbacks, timeoutMs = DEFAULT_TIMEOUT_MS) => {
      const subscription = await subscribeRemoteRuntimeRequest(
        pairing,
        method,
        params,
        timeoutMs,
        callbacks,
        { clientCapabilities: capabilities }
      )
      open.add(subscription)
      return subscription
    },
    dispose: () => {
      for (const subscription of open) {
        subscription.close()
      }
      open.clear()
    }
  }
}

/** The phone QR a desktop shows in Settings, minted LAN-only so no Relay is involved. */
export async function createDesktopMobilePairingOffer(
  desktopPage: Page
): Promise<{ pairingUrl: string }> {
  return desktopPage.evaluate(async () => {
    const offer = await window.api.mobile.getPairingQR({
      address: '127.0.0.1',
      connectionMode: 'local-only',
      rotate: true
    })
    if (!offer.available) {
      throw new Error(`Desktop did not mint a mobile pairing offer: ${JSON.stringify(offer)}`)
    }
    return { pairingUrl: offer.pairingUrl }
  })
}
