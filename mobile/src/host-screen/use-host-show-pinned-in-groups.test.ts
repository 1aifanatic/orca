import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
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

type Hook = ReturnType<typeof useHostShowPinnedInGroups>

async function mountHook(client: RpcClient) {
  const held: { current: Hook | null } = { current: null }
  function Probe({ client }: { client: RpcClient }): null {
    held.current = useHostShowPinnedInGroups({ client, connState: 'connected' })
    return null
  }
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(Probe, { client }))
  })
  return {
    hook: () => held.current!,
    switchTo: (next: RpcClient) =>
      act(async () => {
        renderer?.update(createElement(Probe, { client: next }))
      })
  }
}

function sessionReplying(reply: RpcResponse): FakeSession {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(reply)
  return client
}

async function syncedSetting(reply: RpcResponse): Promise<boolean> {
  const client = sessionReplying(reply)
  const { hook } = await mountHook(client)
  await act(() => hook().syncShowPinnedInGroups())
  expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual(['settings.get'])
  return hook().showPinnedInGroups
}

const showInGroups = settingsReply({ showPinnedWorktreesInGroups: true })

describe('the host list mirrors the desktop pinned-placement setting', () => {
  it('applies the setting the host reports, defaulting to off', async () => {
    expect(await syncedSetting(showInGroups)).toBe(true)
    expect(await syncedSetting(settingsReply({}))).toBe(false)
    expect(await syncedSetting(refusal)).toBe(false)
  })

  it("drops the previous host's setting when the client changes", async () => {
    const { hook, switchTo } = await mountHook(sessionReplying(showInGroups))
    await act(() => hook().syncShowPinnedInGroups())
    await switchTo(sessionReplying(refusal))
    expect(hook().showPinnedInGroups).toBe(false)
  })

  it('ignores a reply that lands after the client changed', async () => {
    const previous = new FakeSession('connected')
    let answer: (reply: RpcResponse) => void = () => {}
    previous.sendRequest.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { hook, switchTo } = await mountHook(previous)
    const pending = hook().syncShowPinnedInGroups()
    await switchTo(sessionReplying(refusal))
    await act(async () => {
      answer(showInGroups)
      await pending
    })
    expect(hook().showPinnedInGroups).toBe(false)
  })
})
