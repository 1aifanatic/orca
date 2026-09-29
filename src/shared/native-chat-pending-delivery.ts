import type { AgentStatusEntry } from './agent-status-types'

export const NATIVE_CHAT_UNCONFIRMED_COPY = 'Delivery unconfirmed — check chat before retrying'
export const NATIVE_CHAT_REJECTED_COPY = 'Message not sent'
export const NATIVE_CHAT_NO_STATUS_DEADLINE_MS = 20_000

export type NativeChatDeliveryStatus = Pick<
  AgentStatusEntry,
  | 'state'
  | 'stateStartedAt'
  | 'mainAgent'
  | 'restoredUnconfirmed'
  | 'sessionBoundary'
  | 'providerSession'
>
export type NativeChatDeliveryOrigin = {
  sentAt: number
  /** A host-clock boundary, never compared with the client's send clock. */
  statusEpoch: number | null
  providerSessionId: string | null
}

export function captureNativeChatDeliveryOrigin(
  status: NativeChatDeliveryStatus | null | undefined,
  sentAt = Date.now()
): NativeChatDeliveryOrigin {
  return {
    sentAt,
    statusEpoch:
      status && !status.restoredUnconfirmed
        ? (status.mainAgent?.stateStartedAt ?? status.stateStartedAt)
        : null,
    providerSessionId: status?.providerSession?.id ?? null
  }
}

/** Delay until a confirmation read is justified, or null while the provider can still queue it. */
export function nativeChatDeliveryCheckDelay(
  origin: NativeChatDeliveryOrigin,
  status: NativeChatDeliveryStatus | null | undefined,
  now = Date.now()
): number | null {
  if (!status || status.restoredUnconfirmed) {
    // Losing an existing status is not evidence that the agent stopped.
    return origin.statusEpoch === null
      ? Math.max(0, origin.sentAt + NATIVE_CHAT_NO_STATUS_DEADLINE_MS - now)
      : null
  }
  if (origin.providerSessionId && status.providerSession?.id !== origin.providerSessionId) {
    return null
  }
  if (status.state === 'working' || status.state === 'waiting' || status.state === 'blocked') {
    return null
  }
  const state = status.mainAgent?.state ?? status.state
  const epoch = status.mainAgent?.stateStartedAt ?? status.stateStartedAt
  return state === 'done' &&
    !status.sessionBoundary &&
    origin.statusEpoch !== null &&
    epoch > origin.statusEpoch
    ? 0
    : null
}

/** A send made before hooks attached can adopt the first live working boundary it observes. */
export function observeNativeChatDeliveryOrigin(
  origin: NativeChatDeliveryOrigin,
  status: NativeChatDeliveryStatus | null | undefined
): NativeChatDeliveryOrigin {
  return origin.statusEpoch === null &&
    status &&
    !status.restoredUnconfirmed &&
    status.state === 'working'
    ? captureNativeChatDeliveryOrigin(status, origin.sentAt)
    : origin
}
