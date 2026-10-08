import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  readyHostSessionInventoryResponse,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'
import type { PtyTransport } from './pty-transport-types'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  runtimeSubscribe,
  subscriptionSendBinary,
  latestSubscribePayload,
  emitSnapshot,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

const PAIRING_CHANGED = 'Runtime environment pairing changed; refresh and try again'

type RevisionedRequest = { method?: string; expectedEnvironmentPairingRevision?: number }

function inputFrameTexts(): string[] {
  return subscriptionSendBinary.mock.calls.flatMap(([bytes]) => {
    const frame = decodeTerminalStreamFrame(bytes)
    return frame?.opcode === TerminalStreamOpcode.Input
      ? [decodeTerminalStreamText(frame.payload)]
      : []
  })
}

function subscribeFrameCount(): number {
  return subscriptionSendBinary.mock.calls.filter(
    ([bytes]) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.Subscribe
  ).length
}

function requestRevision(request: unknown): number | undefined {
  return typeof request === 'object' &&
    request !== null &&
    'expectedEnvironmentPairingRevision' in request &&
    typeof request.expectedEnvironmentPairingRevision === 'number'
    ? request.expectedEnvironmentPairingRevision
    : undefined
}

function subscribeRevisions(): (number | undefined)[] {
  return runtimeSubscribe.mock.calls.map(([request]) => requestRevision(request))
}

/**
 * Main's environment record. A forced managed-server update restarts the server and re-pairs it
 * under the same environment id, so main refuses every request that still carries the old
 * revision — before it reaches the host, whose terminals are untouched.
 */
async function installRepairableMain(): Promise<{
  repair: () => void
  setReachable: (reachable: boolean) => void
}> {
  let mainRevision = 1
  let reachable = true
  const unreachable = (): Error =>
    Object.assign(new Error('Could not connect to the remote Orca runtime.'), {
      code: 'remote_runtime_unavailable'
    })
  const { replaceRuntimeEnvironmentRevisions } =
    await import('@/runtime/runtime-environment-revision')
  const { setRuntimeEnvironmentCatalogRefresher } =
    await import('@/runtime/runtime-environment-pairing-refresh')
  replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 1 }])
  setRuntimeEnvironmentCatalogRefresher(async () => {
    replaceRuntimeEnvironmentRevisions([
      { id: 'env-1', createdAt: 1, pairingRevision: mainRevision }
    ])
  })
  const isStale = (request: RevisionedRequest): boolean =>
    request.expectedEnvironmentPairingRevision !== undefined &&
    request.expectedEnvironmentPairingRevision !== mainRevision
  const hostCall = runtimeCall.getMockImplementation()
  runtimeCall.mockImplementation(async (request: RevisionedRequest) => {
    if (!reachable) {
      throw unreachable()
    }
    if (isStale(request)) {
      return {
        ok: false,
        error: { code: 'runtime_environment_changed', message: PAIRING_CHANGED }
      }
    }
    if (request.method === 'session.tabs.list') {
      return readyHostSessionInventoryResponse('terminal-1', 'host-tab-1')
    }
    return hostCall?.(request)
  })
  const hostSubscribe = runtimeSubscribe.getMockImplementation()
  runtimeSubscribe.mockImplementation(async (request: RevisionedRequest, callbacks: unknown) => {
    if (!reachable) {
      throw unreachable()
    }
    if (isStale(request)) {
      throw new Error(
        `Error invoking remote method 'runtimeEnvironments:subscribe': Error: ${PAIRING_CHANGED}`
      )
    }
    return hostSubscribe?.(request, callbacks)
  })
  return {
    repair: () => {
      mainRevision = 2
    },
    setReachable: (next) => {
      reachable = next
    }
  }
}

async function restartServerUnderLivePane(tabId: string): Promise<{
  transport: PtyTransport
  onError: ReturnType<typeof vi.fn>
  repair: () => void
  setReachable: (reachable: boolean) => void
}> {
  const { repair, setReachable } = await installRepairableMain()
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const onError = vi.fn()
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId,
    leafId: 'pane:1'
  })
  transport.attach({
    existingPtyId: 'remote:env-1@@terminal-1',
    cols: 80,
    rows: 24,
    callbacks: { onError }
  })
  await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-1'))
  emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')
  await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('connected'))
  return { transport, onError, repair, setReachable }
}

// A forced managed-server update re-pairs the environment while its terminals keep running.
describe('remote runtime pane across a pairing rotation', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  afterEach(async () => {
    const { setRuntimeEnvironmentCatalogRefresher } =
      await import('@/runtime/runtime-environment-pairing-refresh')
    setRuntimeEnvironmentCatalogRefresher(null)
  })

  it('rebinds a pane to its still-live terminal on the new pairing and delivers typed keys', async () => {
    const { transport, onError, repair } = await restartServerUnderLivePane('tab-1')
    const firstCallbacks = subscriptionCallbacks

    repair()
    firstCallbacks?.onClose?.()
    expect(transport.sendInput('echo typed-after-update\r', 'driving')).toBe(true)

    await vi.waitFor(() => expect(subscribeRevisions().at(-1)).toBe(2))
    await vi.waitFor(() => expect(subscriptionCallbacks).not.toBe(firstCallbacks))
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
    emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')

    await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('connected'))
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    expect(latestSubscribePayload().terminal).toBe('terminal-1')
    await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('echo typed-after-update\r'))
    expect(onError).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('rebinds a pane whose stream reopened before main re-paired, instead of dropping its keys', async () => {
    const { transport, onError, repair } = await restartServerUnderLivePane('tab-1')
    const firstCallbacks = subscriptionCallbacks
    const { replaceRuntimeEnvironmentRevisions } =
      await import('@/runtime/runtime-environment-revision')

    // The server is back and the stream reopened on the old pairing; main re-pairs only afterwards.
    repair()
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 2 }])

    await vi.waitFor(() => expect(subscribeRevisions().at(-1)).toBe(2))
    await vi.waitFor(() => expect(subscriptionCallbacks).not.toBe(firstCallbacks))
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
    emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')
    await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('connected'))
    expect(transport.sendInput('echo typed-after-repair\r', 'driving')).toBe(true)

    await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('echo typed-after-repair\r'))
    expect(latestSubscribePayload().terminal).toBe('terminal-1')
    expect(onError).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('rebinds a host session pane through its inventory on the new pairing', async () => {
    const { transport, onError, repair } =
      await restartServerUnderLivePane('web-terminal-host-tab-1')
    const firstCallbacks = subscriptionCallbacks

    repair()
    firstCallbacks?.onClose?.()

    await vi.waitFor(() => expect(subscribeRevisions().at(-1)).toBe(2), { timeout: 5_000 })
    await vi.waitFor(() => expect(subscriptionCallbacks).not.toBe(firstCallbacks))
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
    emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')

    await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('connected'))
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    expect(latestSubscribePayload().terminal).toBe('terminal-1')
    expect(onError).not.toHaveBeenCalled()
    transport.destroy?.()
  })

  it('Reconnect rebinds a pane whose retries stopped while the server restarted re-paired', async () => {
    vi.useFakeTimers()
    try {
      const { transport, onError, repair, setReachable } =
        await restartServerUnderLivePane('web-terminal-host-tab-1')
      setReachable(false)
      subscriptionCallbacks?.onClose?.()
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')

      repair()
      setReachable(true)
      // Another subscriber's refusal already brought the renderer catalog to the new revision.
      const { replaceRuntimeEnvironmentRevisions } =
        await import('@/runtime/runtime-environment-revision')
      replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 2 }])
      const subscribesBefore = runtimeSubscribe.mock.calls.length
      runtimeCall.mockClear()
      expect(transport.retryRecovery?.()).toBe(true)

      await vi.waitFor(() =>
        expect(runtimeSubscribe.mock.calls.length).toBeGreaterThan(subscribesBefore)
      )
      expect(subscribeRevisions().at(-1)).toBe(2)
      await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-1'))
      emitSnapshot(latestSubscribePayload().streamId, 'prompt$ ')
      await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('connected'))
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
      for (const [request] of runtimeCall.mock.calls) {
        expect(requestRevision(request)).toBe(2)
      }
      expect(onError).not.toHaveBeenCalled()
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
