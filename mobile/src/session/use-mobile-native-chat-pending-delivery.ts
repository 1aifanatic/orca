import { findLandedImagePreviewEchoes } from './mobile-native-chat-draft-reconcile'
import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react'
import {
  nativeChatDeliveryCheckDelay,
  observeNativeChatDeliveryOrigin,
  type NativeChatDeliveryStatus
} from '../../../src/shared/native-chat-pending-delivery'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatPendingMessage } from './mobile-native-chat-pending-echo'
import { retireLandedMobileNativeChatPending } from './mobile-native-chat-pending-retirement'

export type MobileNativeChatDeliveryTracking = {
  status: NativeChatDeliveryStatus | null | undefined
  readTranscript: () => Promise<NativeChatMessage[] | null>
}

export function useMobileNativeChatPendingDelivery(
  pending: MobileNativeChatPendingMessage[],
  tracking: MobileNativeChatDeliveryTracking | undefined,
  settle: (checked: ReadonlySet<string>, unmatched: ReadonlySet<string>) => void
): void {
  useEffect(() => {
    if (!tracking) {
      return
    }
    const checks = pending.flatMap((entry) => {
      const delay =
        entry.deliveryOrigin && !entry.delivery
          ? nativeChatDeliveryCheckDelay(entry.deliveryOrigin, tracking.status)
          : null
      return delay === null ? [] : [{ entry, delay }]
    })
    if (checks.length === 0) {
      return
    }
    let cancelled = false
    const timer = setTimeout(
      () => {
        void (async () => {
          const due = checks
            .filter(
              ({ entry }) =>
                entry.deliveryOrigin &&
                nativeChatDeliveryCheckDelay(entry.deliveryOrigin, tracking.status) === 0
            )
            .map(({ entry }) => entry)
          if (due.length === 0) {
            return
          }
          const messages = await tracking.readTranscript().catch(() => null)
          if (cancelled || (tracking.status && !tracking.status.restoredUnconfirmed && !messages)) {
            return
          }
          // Keep phone-local images until the normal retirement path rebinds their previews.
          const imageIds = new Set(
            messages
              ? findLandedImagePreviewEchoes(
                  messages,
                  due.filter((entry) => entry.baselineResolved)
                ).map((echo) => echo.pendingId)
              : []
          )
          const remaining = messages
            ? retireLandedMobileNativeChatPending(messages, due, imageIds)
            : due
          settle(new Set(due.map((entry) => entry.id)), new Set(remaining.map((entry) => entry.id)))
        })().catch(() => {
          /* An unreadable host has not proved absence. */
        })
      },
      Math.min(...checks.map(({ delay }) => delay))
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pending, tracking, settle])
}

type PendingByKey = Record<string, MobileNativeChatPendingMessage[]>
export function useMobileNativeChatPendingDeliveryState(
  pending: MobileNativeChatPendingMessage[],
  tracking: MobileNativeChatDeliveryTracking | undefined,
  pendingKey: string | null,
  draftKey: string | null,
  setPendingBySession: Dispatch<SetStateAction<PendingByKey>>,
  setPendingWaitingForSession: Dispatch<SetStateAction<PendingByKey>>
) {
  const updateDeliveryOrigins = useCallback(() => {
    const update = (
      previous: Record<string, MobileNativeChatPendingMessage[]>,
      key: string | null
    ) => {
      if (!key || !previous[key]) {
        return previous
      }
      const next = previous[key].map((entry) => {
        if (!entry.deliveryOrigin || entry.delivery === 'confirmed') {
          return entry
        }
        const origin = observeNativeChatDeliveryOrigin(entry.deliveryOrigin, tracking?.status)
        return origin === entry.deliveryOrigin
          ? entry
          : { ...entry, deliveryOrigin: origin, delivery: undefined }
      })
      return next.every((entry, index) => entry === previous[key]?.[index])
        ? previous
        : { ...previous, [key]: next }
    }
    setPendingBySession((previous) => update(previous, pendingKey))
    setPendingWaitingForSession((previous) => update(previous, draftKey))
  }, [tracking?.status, pendingKey, draftKey, setPendingBySession, setPendingWaitingForSession])
  useEffect(updateDeliveryOrigins, [updateDeliveryOrigins])
  const settleDelivery = useCallback(
    (checked: ReadonlySet<string>, unmatched: ReadonlySet<string>, dismiss = false) => {
      const update = (
        previous: Record<string, MobileNativeChatPendingMessage[]>,
        key: string | null
      ) => {
        if (!key || !previous[key]) {
          return previous
        }
        return {
          ...previous,
          [key]: previous[key].flatMap((entry) =>
            !checked.has(entry.id)
              ? [entry]
              : unmatched.has(entry.id)
                ? [{ ...entry, delivery: 'unconfirmed' as const }]
                : dismiss
                  ? []
                  : [{ ...entry, delivery: 'confirmed' as const }]
          )
        }
      }
      setPendingBySession((previous) => update(previous, pendingKey))
      setPendingWaitingForSession((previous) => update(previous, draftKey))
    },
    [pendingKey, draftKey, setPendingBySession, setPendingWaitingForSession]
  )
  useMobileNativeChatPendingDelivery(pending, tracking, settleDelivery)
  return settleDelivery
}
