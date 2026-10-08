import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const route = vi.hoisted(() => {
  const state: { params: Record<string, string>; capabilities: string[] } = {
    params: {},
    capabilities: []
  }
  return state
})
const desktop = vi.hoisted(() => {
  const state: { client: unknown } = { client: null }
  return state
})

vi.mock('expo-router', () => ({ useLocalSearchParams: () => route.params }))
vi.mock('react-native', () => ({}))
vi.mock('../components/host-protocol-gates-context', () => ({
  useOptionalHostProtocolGates: () => ({ hostCapabilities: route.capabilities })
}))
vi.mock('./client-context', () => ({
  useHostClient: () => ({ client: desktop.client, clientId: 'client-1', state: 'connected' }),
  useForceReconnect: () => () => undefined
}))

import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { WorkspaceRoute } from '../navigation/workspace-route'
import { FakeSession } from './mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from './rpc-client'
import { useWorkspaceClient } from './use-workspace-client'

async function workspaceClientFor(
  params: Record<string, string>,
  capabilities: string[]
): Promise<{ client: RpcClient | null; session: FakeSession }> {
  route.params = params
  route.capabilities = capabilities
  const session = new FakeSession('connected')
  desktop.client = session
  const held: { client: RpcClient | null } = { client: null }
  function Probe(): null {
    held.client = useWorkspaceClient('host-1').client
    return null
  }
  await act(async () => {
    create(createElement(WorkspaceRoute, null, createElement(Probe)))
  })
  return { client: held.client, session }
}

describe('a workspace screen’s client', () => {
  it('runs every call of a server workspace on that server', async () => {
    const { client, session } = await workspaceClientFor({ executionHost: 'runtime:vm' }, [
      MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY
    ])
    await client?.sendRequest('files.readDir', { worktree: 'id:wt' })
    expect(session.sendRequest).toHaveBeenCalledWith(
      'files.readDir',
      { worktree: 'id:wt' },
      { executionHost: 'runtime:vm' }
    )
  })

  it('never falls back to the desktop for a server workspace it cannot reach yet', async () => {
    const { client, session } = await workspaceClientFor({ executionHost: 'runtime:vm' }, [])
    expect(client).toBeNull()
    expect(session.sendRequest).not.toHaveBeenCalled()
  })

  it('keeps the desktop’s own client for the desktop’s own workspaces', async () => {
    const { client, session } = await workspaceClientFor({}, [
      MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY
    ])
    expect(client).toBe(session)
  })
})
