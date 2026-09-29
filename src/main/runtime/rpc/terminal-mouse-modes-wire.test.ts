import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalStreamConsumers } from '../runtime-terminal-stream-consumers'
import {
  startDesktopMultiplexSubscribe,
  sendDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import {
  buildSnapshotFrameMeta,
  terminalSnapshotPayloadJsonBytes
} from './methods/terminal/terminal-snapshot-payload'
import type { SnapshotFrameOptions } from './methods/terminal/terminal-stream-types'

const mouseModes = {
  seq: 50,
  mouseTracking: true,
  mouseTrackingMode: 'any',
  sgrMouseMode: true,
  sgrMousePixelsMode: false
} as const

const options: SnapshotFrameOptions = {
  kind: 'scrollback',
  cols: 80,
  rows: 24,
  data: 'screen',
  seq: 50,
  mouseModes
}

describe('optional terminal mouse metadata', () => {
  it('includes modes in snapshot frames and their JSON byte budget', () => {
    expect(buildSnapshotFrameMeta(options).mouseModes).toEqual(mouseModes)
    const payload = {
      ...buildSnapshotFrameMeta(options),
      type: options.kind,
      streamId: 7,
      serialized: options.data
    }
    expect(terminalSnapshotPayloadJsonBytes(options, 7)).toBe(
      Buffer.byteLength(JSON.stringify(payload))
    )
    expect(buildSnapshotFrameMeta({ ...options, mouseModes: undefined })).not.toHaveProperty(
      'mouseModes'
    )
  })

  it('sends late-attach modes and live changes through existing frames and stops after detach', async () => {
    const consumers = new RuntimeTerminalStreamConsumers()
    const run = startDesktopMultiplexSubscribe({
      subscribeToTerminalData: consumers.subscribe.bind(consumers),
      serializeTerminalBuffer: vi
        .fn()
        .mockResolvedValue({ data: 'screen', cols: 80, rows: 24, seq: 50, mouseModes })
    })
    await vi.waitFor(() => expect(run.handlers.has(0)).toBe(true))
    sendDesktopMultiplexSubscribe(run.handlers)
    const frames = () =>
      run.binaryFrames.map(decodeTerminalStreamFrame).filter((frame) => frame !== null)
    await vi.waitFor(() =>
      expect(frames().some((frame) => frame.opcode === TerminalStreamOpcode.SnapshotEnd)).toBe(true)
    )
    const snapshot = frames().find((frame) => frame.opcode === TerminalStreamOpcode.SnapshotStart)
    expect(snapshot && decodeTerminalStreamJson(snapshot.payload)).toMatchObject({ mouseModes })
    consumers.publishMouseModes('pty-1', { ...mouseModes, seq: 60, sgrMouseMode: false })
    const metadata = frames().find((frame) => frame.opcode === TerminalStreamOpcode.Metadata)
    expect(metadata && decodeTerminalStreamJson(metadata.payload)).toEqual({
      mouseModes: { ...mouseModes, seq: 60, sgrMouseMode: false }
    })
    run.registry.cleanupSubscriptionsForConnection('conn-desktop-first-paint')
    await run.dispatchPromise
    const count = run.binaryFrames.length
    consumers.publishMouseModes('pty-1', { ...mouseModes, seq: 70 })
    expect(run.binaryFrames).toHaveLength(count)
  })
  it.each([true, false])(
    'carries modes on the legacy subscription (binary: %s)',
    async (binary) => {
      const consumers = new RuntimeTerminalStreamConsumers()
      const run = startDesktopMultiplexSubscribe({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        handleMobileSubscribe: vi.fn().mockResolvedValue(true),
        handleMobileUnsubscribe: vi.fn(),
        hasHeadlessTerminalState: vi.fn().mockReturnValue(true),
        isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
        subscribeToTerminalData: consumers.subscribe.bind(consumers),
        serializeTerminalBuffer: vi
          .fn()
          .mockResolvedValue({ data: 'screen', cols: 80, rows: 24, seq: 50, mouseModes })
      })
      const messages: string[] = []
      const frames: Uint8Array<ArrayBufferLike>[] = []
      const dispatcher = new RpcDispatcher({ runtime: run.runtime, methods: TERMINAL_METHODS })
      const pending = dispatcher.dispatchStreaming(
        {
          id: 'legacy-mouse',
          authToken: 'tok',
          method: 'terminal.subscribe',
          params: {
            terminal: 'terminal-1',
            client: { id: 'legacy-1', type: binary ? 'mobile' : 'desktop' },
            capabilities: binary ? { terminalBinaryStream: 1 } : {}
          }
        },
        (value) => messages.push(value),
        {
          connectionId: 'legacy-mouse',
          sendBinary: (value) => {
            frames.push(value)
          }
        }
      )
      const payloads = () =>
        binary
          ? frames
              .map(decodeTerminalStreamFrame)
              .filter(
                (frame) =>
                  frame &&
                  (frame.opcode === TerminalStreamOpcode.SnapshotStart ||
                    frame.opcode === TerminalStreamOpcode.Metadata)
              )
              .map((frame) => frame && decodeTerminalStreamJson(frame.payload))
              .map((value) => JSON.stringify(value))
              .join('\n')
          : messages.join('\n')
      try {
        await vi.waitFor(() => expect(payloads()).toContain(JSON.stringify(mouseModes)))
        const disabled = {
          ...mouseModes,
          seq: 60,
          mouseTracking: false,
          mouseTrackingMode: 'none' as const
        }
        consumers.publishMouseModes('pty-1', disabled)
        expect(payloads()).toContain(JSON.stringify(disabled))
      } finally {
        run.registry.cleanupSubscriptionsForConnection('legacy-mouse')
        run.registry.cleanupSubscriptionsForConnection('conn-desktop-first-paint')
        await Promise.all([pending, run.dispatchPromise])
      }
    }
  )
})
