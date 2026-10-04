import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'

import { useHostViewSettings } from './use-host-view-settings'

const refusal: RpcResponse = {
  id: 'reply',
  ok: false,
  error: { code: 'runtime_error', message: 'refused' },
  _meta: { runtimeId: 'runtime' }
}

function settingsReply(settings: unknown): RpcResponse {
  return { id: 'reply', ok: true, result: { settings }, _meta: { runtimeId: 'runtime' } }
}

async function syncedPolicies(reply: RpcResponse, swapClientMidRead = false): Promise<string[]> {
  const client = new FakeSession('connected')
  const clientRef: { current: unknown } = { current: client }
  client.sendRequest.mockImplementation(async (method: string) => {
    if (swapClientMidRead) {
      clientRef.current = new FakeSession('connected')
    }
    // ui.get refuses so only the placement read can move state.
    return method === 'settings.get' ? reply : refusal
  })
  const policies: string[] = []
  const state = {
    clientRef,
    collapsedGroups: new Set(),
    filters: { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
    setPinnedDisplayPolicy: (policy: string) => policies.push(policy),
    viewStateRef: { current: {} },
    workspaceStatuses: []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sync reads only clientRef and setPinnedDisplayPolicy; the rest feed the mount-time ref mirror.
  const args = { client, connState: 'connected', hostId: 'host-1', state } as unknown as Parameters<
    typeof useHostViewSettings
  >[0]
  const held: { sync: (() => Promise<void>) | null } = { sync: null }
  function Probe(): null {
    held.sync = useHostViewSettings(args).syncViewSettingsFromDesktop
    return null
  }
  await act(async () => {
    create(createElement(Probe))
  })
  await act(async () => {
    await held.sync?.()
  })
  expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
    'ui.get',
    'settings.get'
  ])
  return policies
}

describe('the host list mirrors the desktop pinned-placement setting', () => {
  it('applies the policy the host reports', async () => {
    expect(await syncedPolicies(settingsReply({ showPinnedWorktreesInGroups: true }))).toEqual([
      'duplicate-in-groups'
    ])
    expect(await syncedPolicies(settingsReply({}))).toEqual(['single-location'])
  })

  it('keeps the current policy on a refusal or a reply for a replaced client', async () => {
    expect(await syncedPolicies(refusal)).toEqual([])
    const late = settingsReply({ showPinnedWorktreesInGroups: true })
    expect(await syncedPolicies(late, true)).toEqual([])
  })
})
