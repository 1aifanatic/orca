import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import { useHostShowPinnedInGroups } from './use-host-show-pinned-in-groups'

const refusal: RpcResponse = {
  id: 'reply',
  ok: false,
  error: { code: 'runtime_error', message: 'refused' },
  _meta: { runtimeId: 'runtime' }
}

function settingsReply(settings: unknown): RpcResponse {
  return { id: 'reply', ok: true, result: { settings }, _meta: { runtimeId: 'runtime' } }
}

async function syncedSetting(reply: RpcResponse, swapClientMidRead = false): Promise<boolean> {
  const client = new FakeSession('connected')
  const clientRef: { current: RpcClient | null } = { current: client }
  client.sendRequest.mockImplementation(async () => {
    if (swapClientMidRead) {
      clientRef.current = new FakeSession('connected')
    }
    return reply
  })
  const held: { current: ReturnType<typeof useHostShowPinnedInGroups> | null } = { current: null }
  function Probe(): null {
    held.current = useHostShowPinnedInGroups({ client, connState: 'connected', clientRef })
    return null
  }
  await act(async () => {
    create(createElement(Probe))
  })
  await act(async () => {
    await held.current?.syncShowPinnedInGroups()
  })
  expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual(['settings.get'])
  return held.current?.showPinnedInGroups ?? false
}

describe('the host list mirrors the desktop pinned-placement setting', () => {
  it('applies the setting the host reports', async () => {
    expect(await syncedSetting(settingsReply({ showPinnedWorktreesInGroups: true }))).toBe(true)
    expect(await syncedSetting(settingsReply({}))).toBe(false)
  })

  it('keeps the default on a refusal or a reply for a replaced client', async () => {
    expect(await syncedSetting(refusal)).toBe(false)
    const late = settingsReply({ showPinnedWorktreesInGroups: true })
    expect(await syncedSetting(late, true)).toBe(false)
  })
})
