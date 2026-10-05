import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, runtimeSubscribe, subscriptionSendBinary, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => subscriptionCallbacks,
    setCallbacks: (callbacks) => {
      subscriptionCallbacks = callbacks
    },
    getResolvedPaneHandle: () => resolvedPaneHandle,
    setResolvedPaneHandle: (handle) => {
      resolvedPaneHandle = handle
    }
  })

// What a relaunched desktop host answers before its renderer has published a window graph.
const UNPUBLISHED_HOST_GRAPH = {
  ok: true,
  result: {
    worktree: 'wt-1',
    publicationEpoch: 'none:client-navigation',
    snapshotVersion: 0,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

describe('remote runtime pty transport against a relaunched host that has not published', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('keeps the pane attachable when the first post-restart inventory is an unpublished empty graph', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const onExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1',
      onPtyExit
    })
    await transport.connect({ url: '', callbacks: { onExit } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const ptyId = transport.getPtyId()
    expect(ptyId).toBe('remote:env-1@@terminal-1')

    let published = false
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'session.tabs.activate') {
        return published
          ? readyHostSessionInventoryResponse('terminal-1')
          : { ok: false, error: { code: 'runtime_error', message: 'tab_not_found' } }
      }
      if (request.method === 'session.tabs.list') {
        return published ? readyHostSessionInventoryResponse('terminal-1') : UNPUBLISHED_HOST_GRAPH
      }
      return { ok: true, result: {} }
    })

    // The host app quit and relaunched; its daemon PTY survived.
    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'session.tabs.list' })
      )
    )
    await Promise.resolve()

    // An unpublished graph is not evidence the surface or its process is gone.
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe(ptyId)

    published = true
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2), { timeout: 10_000 })
    expect(transport.getPtyId()).toBe(ptyId)
  })
})
