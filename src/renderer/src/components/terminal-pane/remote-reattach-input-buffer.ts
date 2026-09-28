import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { createPtyPreconnectInputBuffer } from './pty-preconnect-input-buffer'
import type { PtyTransport } from './pty-transport-types'

/** Keeps type-ahead on a restored screen bound to its original remote terminal. */
export function withRemoteReattachInputBuffer(transport: PtyTransport): PtyTransport {
  const sendAccepted = transport.sendInputAccepted?.bind(transport)
  let pending: ReturnType<typeof createPtyPreconnectInputBuffer> | null = null
  let pendingExpectedId: string | null = null
  const clear = (): void => {
    pending?.clear()
    pending = null
    pendingExpectedId = null
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
  const wrapped: PtyTransport = {
    ...transport,
    async connect(options) {
      clear()
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
      return kind !== 'query-reply' && pending?.isBuffering()
        ? pending.enqueue(data, 'ordinary', kind)
        : transport.sendInput(data, kind)
    },
    // Emulator replies stay on the immediate path; replay must not retain them as user input.
    ...(sendAccepted
      ? {
          sendInputAccepted: (data, kind) =>
            kind !== 'query-reply' && pending?.isBuffering()
              ? pending.enqueueAccepted(data, kind)
              : sendAccepted(data, kind)
        }
      : {}),
    attach(options) {
      clear()
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
    if (pending && pendingExpectedId) {
      flush(pending, pendingExpectedId)
    }
  })
  return wrapped
}
