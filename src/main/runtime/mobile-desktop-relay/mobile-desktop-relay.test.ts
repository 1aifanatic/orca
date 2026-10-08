import { describe, expect, it, vi } from 'vitest'
import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from '../../../shared/delegated-mobile-device-contract'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime-client-error'
import type { RemoteRuntimePassthroughCallbacks } from '../../../shared/remote-runtime-passthrough-socket'
import { MobileDesktopRelay, type RelayedPhone } from './mobile-desktop-relay'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

type FakeSocket = {
  sent: string[]
  capabilities: readonly string[]
  callbacks: RemoteRuntimePassthroughCallbacks
  closed: boolean
}
const sockets = vi.hoisted(() => {
  const opened: FakeSocket[] = []
  return opened
})
vi.mock('../../../shared/remote-runtime-passthrough-socket', () => ({
  openRemoteRuntimePassthroughSocket: async (
    _pairing: unknown,
    capabilities: readonly string[],
    callbacks: RemoteRuntimePassthroughCallbacks
  ) => {
    const socket: FakeSocket = { sent: [], capabilities, callbacks, closed: false }
    sockets.push(socket)
    return {
      send: (frame: string) => {
        socket.sent.push(frame)
        return true
      },
      close: () => {
        socket.closed = true
      }
    }
  }
}))

const ok = (result: unknown) => ({ id: 'x', ok: true as const, result, _meta: { runtimeId: 'h' } })

function relayWithPhone() {
  const hosts: MobileDesktopRelayHosts = {
    resolve: async (environmentId) => ({
      environmentId,
      fence: 'f',
      pairing: { v: 2, endpoint: 'ws://127.0.0.1:1', deviceToken: 'desktop', publicKeyB64: 'k' }
    }),
    call: async (_host, method) =>
      method === 'status.get'
        ? ok({ capabilities: [DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY] })
        : ok({ devices: [{ phoneKey: 'phone-1', deviceId: 'child', token: 'host-token' }] }),
    onEnvironmentRetired: () => () => {}
  }
  const relay = new MobileDesktopRelay({
    hosts,
    listPhones: () => [{ phoneKey: 'phone-1', name: 'iPhone via Mac' }],
    allocateStreamId: () => 1
  })
  const replies: string[] = []
  let capabilities: readonly string[] = ['cap.a']
  const phone: RelayedPhone = {
    connectionId: 'conn-1',
    deviceId: 'phone-1',
    deviceToken: 'desktop-token',
    clientCapabilities: () => capabilities,
    reply: (frame) => replies.push(frame),
    sendBinary: () => true
  }
  return { relay, phone, replies, setCapabilities: (next: string[]) => (capabilities = next) }
}

describe('MobileDesktopRelay', () => {
  it('signs in with exactly the phone capabilities and mirrors its updates without a second answer', async () => {
    sockets.length = 0
    const { relay, phone, replies, setCapabilities } = relayWithPhone()
    relay.forward(
      phone,
      'env-1',
      { id: 'r1', method: 'terminal.list' },
      '{"id":"r1","method":"terminal.list"}'
    )
    relay.forward(
      phone,
      'env-2',
      { id: 'r2', method: 'terminal.list' },
      '{"id":"r2","method":"terminal.list"}'
    )
    await vi.waitFor(() => expect(sockets.map((socket) => socket.sent.length)).toEqual([1, 1]))
    expect(sockets[0]!.capabilities).toEqual(['cap.a'])

    setCapabilities(['cap.b'])
    const update = JSON.stringify({
      id: 'caps',
      deviceToken: 'desktop-token',
      method: 'runtime.clientCapabilities.update',
      params: { clientCapabilities: ['cap.b'] }
    })
    relay.forwardClientCapabilities('conn-1', update)
    relay.forwardClientCapabilities('other-connection', update)
    await vi.waitFor(() => expect(sockets.map((socket) => socket.sent.length)).toEqual([2, 2]))
    for (const socket of sockets) {
      const mirrored = JSON.parse(socket.sent[1]!)
      expect(mirrored).toMatchObject({
        method: 'runtime.clientCapabilities.update',
        params: { clientCapabilities: ['cap.b'] }
      })
      expect(mirrored.id).not.toBe('caps')
      expect(mirrored.deviceToken).toBeUndefined()
      // The host's answer to the mirror is the relay's, not the phone's.
      socket.callbacks.onText(JSON.stringify({ id: mirrored.id, ok: true, result: {}, _meta: {} }))
    }
    expect(replies).toEqual([])
  })

  it('answers every request still open when the server socket drops, then closes on phone disconnect', async () => {
    sockets.length = 0
    const { relay, phone, replies } = relayWithPhone()
    relay.forward(phone, 'env-1', { id: 'a', method: 'terminal.list' }, '{"id":"a"}')
    relay.forward(phone, 'env-1', { id: 'b', method: 'terminal.list' }, '{"id":"b"}')
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(2))
    // One socket per (phone connection, server) carries both requests.
    expect(sockets).toHaveLength(1)
    sockets[0]!.callbacks.onText('{"id":"a","ok":true,"result":{},"_meta":{"runtimeId":"h"}}')
    sockets[0]!.callbacks.onClose(
      new RemoteRuntimeClientError('remote_runtime_unavailable', 'gone')
    )
    expect(replies.map((frame) => JSON.parse(frame))).toEqual([
      { id: 'a', ok: true, result: {}, _meta: { runtimeId: 'h' } },
      expect.objectContaining({
        id: 'b',
        ok: false,
        error: expect.objectContaining({ code: 'remote_runtime_unavailable' })
      })
    ])

    relay.forward(phone, 'env-1', { id: 'c', method: 'terminal.list' }, '{"id":"c"}')
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    relay.closePhoneConnection('conn-1')
    expect(sockets[1]!.closed).toBe(true)
  })
})
