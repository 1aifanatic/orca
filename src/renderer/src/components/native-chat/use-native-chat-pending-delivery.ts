import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store'
import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  captureNativeChatDeliveryOrigin,
  observeNativeChatDeliveryOrigin,
  nativeChatDeliveryCheckDelay,
  NATIVE_CHAT_REJECTED_COPY,
  NATIVE_CHAT_UNCONFIRMED_COPY
} from '../../../../shared/native-chat-pending-delivery'
import {
  appendPendingSendCache,
  nextNativeChatPendingSendId,
  pendingSendsAsMessages,
  prunePendingSends,
  readPendingSendCache,
  writePendingSendCache,
  type NativeChatPendingSend
} from './native-chat-pending'
import { getNativeChatSessionTransport } from './native-chat-session-transport'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

const NO_NOTICES: ReadonlyMap<string, NativeChatDeliveryNotice> = new Map()

/** Pending presentation follows the existing status store; a fresh read checks each completed turn. */
export function useNativeChatPendingDelivery(args: {
  paneKey: string
  agent: AgentType
  sessionId: string | null
  transcriptPath?: string | null
  runtimeEnvironmentId: string | null
  messages: NativeChatMessage[]
}) {
  const { paneKey, agent, sessionId, transcriptPath, runtimeEnvironmentId, messages } = args
  const scope = useMemo(() => ({ paneKey, agent }), [paneKey, agent])
  const status = useAppStore((s) => s.agentStatusByPaneKey[paneKey])
  const [pending, setPending] = useState(() => readPendingSendCache(scope))
  useEffect(() => setPending(readPendingSendCache(scope)), [scope])
  const save = useCallback(
    (update: (entries: NativeChatPendingSend[]) => NativeChatPendingSend[]) => {
      const current = readPendingSendCache(scope)
      const next = update(current)
      // Why: prune and status observation run on every stream/status update; a no-op must not re-render.
      if (next !== current) {
        setPending(writePendingSendCache(scope, next))
      }
    },
    [scope]
  )
  useEffect(() => {
    save((entries) => prunePendingSends(entries, messages))
  }, [messages, save])
  useEffect(() => {
    save((entries) => {
      const next = entries.map((entry) => {
        if (
          !entry.deliveryOrigin ||
          entry.delivery === 'rejected' ||
          entry.delivery === 'confirmed'
        ) {
          return entry
        }
        const origin = observeNativeChatDeliveryOrigin(entry.deliveryOrigin, status)
        return origin === entry.deliveryOrigin
          ? entry
          : { ...entry, deliveryOrigin: origin, delivery: undefined }
      })
      return next.every((entry, index) => entry === entries[index]) ? entries : next
    })
  }, [status, save])
  const record = useCallback(
    (text: string, imagePaths?: string[]) => {
      const sentAt = Date.now()
      const boundary = messages.at(-1)
      const entry: NativeChatPendingSend = {
        id: nextNativeChatPendingSendId(sentAt),
        text,
        sentAt,
        afterMessageId: boundary?.id ?? null,
        afterMessageTimestamp: boundary?.timestamp ?? null,
        ...(imagePaths ? { imagePaths } : {}),
        ...(agent === 'claude'
          ? { deliveryOrigin: captureNativeChatDeliveryOrigin(status, sentAt) }
          : {})
      }
      setPending(appendPendingSendCache(scope, entry))
      return entry.id
    },
    [messages, agent, status, scope]
  )
  const cancel = useCallback(
    (id: string) => save((entries) => entries.filter((entry) => entry.id !== id)),
    [save]
  )
  const reject = useCallback(
    (id: string) =>
      save((entries) =>
        entries.map((entry) => (entry.id === id ? { ...entry, delivery: 'rejected' } : entry))
      ),
    [save]
  )
  const clear = useCallback(() => save(() => []), [save])

  useEffect(() => {
    if (agent !== 'claude') {
      return
    }
    const candidates = pending.filter((entry) => entry.deliveryOrigin && !entry.delivery)
    const checks = candidates.flatMap((entry) => {
      const delay = entry.deliveryOrigin
        ? nativeChatDeliveryCheckDelay(entry.deliveryOrigin, status)
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
                nativeChatDeliveryCheckDelay(entry.deliveryOrigin, status) === 0
            )
            .map(({ entry }) => entry)
          if (due.length === 0) {
            return
          }
          const result = sessionId
            ? await getNativeChatSessionTransport(runtimeEnvironmentId)
                .readSession(agent, sessionId, 500, transcriptPath ?? undefined)
                .catch(() => null)
            : null
          if (cancelled) {
            return
          }
          // A failed or not-yet-created transcript cannot prove absence after an idle fact.
          if (status && !status.restoredUnconfirmed && (!result || !('messages' in result))) {
            return
          }
          const history = result && 'messages' in result ? result.messages : messages
          const unmatched = new Set(
            pendingSendsAsMessages(due, history).map((message) => message.id)
          )
          const dueIds = new Set(due.map((entry) => entry.id))
          save((entries) =>
            entries.flatMap((entry) => {
              if (!dueIds.has(entry.id) || entry.delivery === 'rejected') {
                return [entry]
              }
              return unmatched.has(`pending:${entry.id}`)
                ? [{ ...entry, delivery: 'unconfirmed' as const }]
                : [{ ...entry, delivery: 'confirmed' as const }]
            })
          )
        })().catch(() => {
          /* A failed read is not evidence of non-delivery. */
        })
      },
      Math.min(...checks.map(({ delay }) => delay))
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [agent, pending, status, sessionId, transcriptPath, runtimeEnvironmentId, messages, save])

  const notices = useMemo(() => {
    if (!pending.some((entry) => entry.delivery && entry.delivery !== 'confirmed')) {
      return NO_NOTICES
    }
    const result = new Map<string, NativeChatDeliveryNotice>()
    for (const entry of pending) {
      if (!entry.delivery || entry.delivery === 'confirmed') {
        continue
      }
      result.set(`pending:${entry.id}`, {
        text:
          entry.delivery === 'rejected' ? NATIVE_CHAT_REJECTED_COPY : NATIVE_CHAT_UNCONFIRMED_COPY,
        onDismiss: () => cancel(entry.id)
      })
    }
    return result
  }, [pending, cancel])
  return { pending, record, cancel, reject, clear, notices }
}
