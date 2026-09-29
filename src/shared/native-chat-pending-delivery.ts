import type { AgentStatusEntry, AgentStatusState } from './agent-status-types'

export const NATIVE_CHAT_UNCONFIRMED_COPY = 'Delivery unconfirmed — check chat before retrying'
export const NATIVE_CHAT_REJECTED_COPY = 'Message not sent'
/** How long a send may go without starting a turn before its absence is checked. */
export const NATIVE_CHAT_UNSTARTED_SEND_DEADLINE_MS = 20_000

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
  /** Live state when the send was written; null when no live status was known. */
  stateAtSend: AgentStatusState | null
}

function liveStatus(
  status: NativeChatDeliveryStatus | null | undefined
): NativeChatDeliveryStatus | null {
  return status && !status.restoredUnconfirmed ? status : null
}

function statusEpoch(status: NativeChatDeliveryStatus): number {
  return status.mainAgent?.stateStartedAt ?? status.stateStartedAt
}

export function captureNativeChatDeliveryOrigin(
  status: NativeChatDeliveryStatus | null | undefined,
  sentAt = Date.now()
): NativeChatDeliveryOrigin {
  const live = liveStatus(status)
  return {
    sentAt,
    statusEpoch: live ? statusEpoch(live) : null,
    providerSessionId: status?.providerSession?.id ?? null,
    stateAtSend: live?.state ?? null
  }
}

function unstartedSendDelay(origin: NativeChatDeliveryOrigin, now: number): number {
  return Math.max(0, origin.sentAt + NATIVE_CHAT_UNSTARTED_SEND_DEADLINE_MS - now)
}

/** Delay until a confirmation read is justified, or null while absence would prove nothing. */
export function nativeChatDeliveryCheckDelay(
  origin: NativeChatDeliveryOrigin,
  status: NativeChatDeliveryStatus | null | undefined,
  now = Date.now()
): number | null {
  // Why: Claude folds a prompt sent during a busy turn into that turn as a queued-command
  // record, which the transcript reader drops, so its absence after the turn proves nothing.
  if (origin.stateAtSend !== null && origin.stateAtSend !== 'done') {
    return null
  }
  const live = liveStatus(status)
  if (!live) {
    // Losing an existing status is not evidence that the agent stopped.
    return origin.statusEpoch === null ? unstartedSendDelay(origin, now) : null
  }
  if (origin.providerSessionId && live.providerSession?.id !== origin.providerSessionId) {
    return null
  }
  if (live.state === 'working' || live.state === 'waiting' || live.state === 'blocked') {
    return null
  }
  const state = live.mainAgent?.state ?? live.state
  const epoch = statusEpoch(live)
  if (state !== 'done' || origin.statusEpoch === null) {
    return null
  }
  if (epoch === origin.statusEpoch) {
    // An idle agent starts a turn on a delivered prompt at once; staying idle means it has not.
    return unstartedSendDelay(origin, now)
  }
  return epoch > origin.statusEpoch && !live.sessionBoundary ? 0 : null
}

/** A send made before hooks attached can adopt the first live working boundary it observes. */
export function observeNativeChatDeliveryOrigin(
  origin: NativeChatDeliveryOrigin,
  status: NativeChatDeliveryStatus | null | undefined
): NativeChatDeliveryOrigin {
  const live = liveStatus(status)
  return origin.statusEpoch === null && live?.state === 'working'
    ? // Keep the unknown send-time state: this turn may be the one the send started.
      { ...captureNativeChatDeliveryOrigin(live, origin.sentAt), stateAtSend: origin.stateAtSend }
    : origin
}
