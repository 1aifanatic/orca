import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { createPtyPreconnectInputBuffer } from './pty-preconnect-input-buffer'
import type { PtyTransport } from './pty-transport-types'

/** Keeps type-ahead on a restored screen bound to its original remote terminal. */
export function withRemoteReattachInputBuffer(transport: PtyTransport): PtyTransport {
  const sendAccepted = transport.sendInputAccepted?.bind(transport)
  let pending: ReturnType<typeof createPtyPreconnectInputBuffer> | null = null
  let pendingExpectedId: string | null = null
  let connectionReady = false
  const clear = (): void => {
    pending?.clear()
    pending = null
    pendingExpectedId = null
    connectionReady = false
  }
  const flush = (
    buffer: ReturnType<typeof createPtyPreconnectInputBuffer>,
    expectedId: string
  ): Promise<void> => {
    return buffer.flush({
      isCurrent: () => pending === buffer && transport.getPtyId() === expectedId,
      sendInput: (data, kind) => transport.sendInput(data, kind),
      sendInputImmediate: (data) => transport.sendInputImmediate(data),
      ...(sendAccepted ? { sendInputAccepted: sendAccepted } : {})
    })
  }
  const ensurePending = (): ReturnType<typeof createPtyPreconnectInputBuffer> => {
    if (!pending) {
      pending = createPtyPreconnectInputBuffer()
      pendingExpectedId = transport.getPtyId()
    }
    return pending
  }
  const wrapped: PtyTransport = {
    ...transport,
    async connect(options) {
      clear()
      connectionReady = false
      const expectedId = options.sessionId
      const buffer =
        expectedId && parseRemoteRuntimePtyId(expectedId) ? createPtyPreconnectInputBuffer() : null
      pending = buffer
      pendingExpectedId = expectedId ?? null
      try {
        const result = await transport.connect(options)
        if (buffer && expectedId) {
          await flush(buffer, expectedId)
        }
        return result
      } finally {
        buffer?.clear()
        if (pending === buffer) {
          pending = null
          pendingExpectedId = null
        }
      }
    },
    sendInput(data, kind) {
      console.warn('[remote-reattach-debug] send', {
        kind,
        connected: transport.isConnected(),
        ready: connectionReady,
        buffering: pending?.isBuffering() ?? null,
        length: data.length
      })
      if (
        kind !== 'query-reply' &&
        (pending?.isBuffering() === true || (!connectionReady && !transport.isConnected()))
      ) {
        return ensurePending().enqueue(data, 'ordinary', kind)
      }
      return transport.sendInput(data, kind)
    },
    // Emulator replies stay on the immediate path; replay must not retain them as user input.
    ...(sendAccepted
      ? {
          sendInputAccepted: (data, kind) =>
            kind !== 'query-reply' &&
            (pending?.isBuffering() === true || (!connectionReady && !transport.isConnected()))
              ? ensurePending().enqueueAccepted(data, kind)
              : sendAccepted(data, kind)
        }
      : {}),
    attach(options) {
      console.warn('[remote-reattach-debug] attach', options.existingPtyId)
      clear()
      connectionReady = false
      const expectedId = options.existingPtyId
      const buffer = parseRemoteRuntimePtyId(expectedId) ? createPtyPreconnectInputBuffer() : null
      pending = buffer
      pendingExpectedId = expectedId
      transport.attach(options)
    },
    disconnect() {
      clear()
      transport.disconnect()
    },
    ...(transport.detach
      ? {
          detach: (options) => {
            clear()
            transport.detach?.(options)
          }
        }
      : {}),
    destroy(options) {
      clear()
      return transport.destroy?.(options)
    }
  }
  transport.setConnectForRecovery?.((options) => wrapped.connect(options))
  transport.setConnectionReady?.(() => {
    console.warn('[remote-reattach-debug] ready', {
      id: transport.getPtyId(),
      buffering: pending?.isBuffering() ?? null
    })
    connectionReady = true
    if (pending) {
      const expectedId = pendingExpectedId ?? transport.getPtyId()
      if (expectedId) {
        void flush(pending, expectedId)
      }
    }
  })
  return wrapped
}
