import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import { useMobileDiffReviewController } from './use-mobile-diff-review-controller'
import { SESSION_TABS_UNAVAILABLE_MESSAGE } from './use-mobile-diff-review-interactions'

vi.mock('./mobile-diff-review-loaders', () => ({
  loadMobileDiffReviewSnapshot: vi.fn().mockResolvedValue({
    kind: 'ready',
    status: {
      entries: [{ path: 'src/app.ts', status: 'modified', area: 'unstaged' }],
      conflictOperation: 'unknown',
      branch: 'feature',
      head: 'abc123',
      upstreamStatus: undefined
    },
    comments: [],
    reviewState: { version: 1, files: {} },
    branchCompare: null
  } satisfies ReviewScreenState),
  loadMobileDiffReviewDiff: vi.fn().mockResolvedValue({ kind: 'idle' })
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  selectionAsync: vi.fn(),
  performAndroidHapticsAsync: vi.fn(),
  AndroidHaptics: {},
  ImpactFeedbackStyle: {},
  NotificationFeedbackType: {}
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))

type Controller = ReturnType<typeof useMobileDiffReviewController>

function clientAnsweringOpenDiff(reply: RpcResponse) {
  const send = vi.fn(async (method: string, _params?: unknown) =>
    method === 'files.openDiff' ? reply : new Promise<RpcResponse>(() => {})
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller only sends requests through this client.
  return { client: { sendRequest: send } as unknown as RpcClient, send }
}

describe('review screen Open in Session', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: Controller | null = null

  async function mount(client: RpcClient, onOpenSession: () => void): Promise<Controller> {
    function Probe(): null {
      controller = useMobileDiffReviewController({
        client,
        connState: 'connected',
        hostId: 'host-1',
        worktreeId: 'wt-1',
        name: 'review',
        initialFilter: 'all',
        initialTarget: null,
        onOpenSession,
        onReconnect: () => {}
      })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Probe))
      await Promise.resolve()
    })
    if (!controller?.currentItem) {
      throw new Error('review did not load a file')
    }
    return controller
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    controller = null
  })

  it('explains, and turns the action off, when the host has no renderer to open a tab', async () => {
    const { client } = clientAnsweringOpenDiff({
      id: 'request-1',
      ok: false,
      error: { code: 'runtime_error', message: 'renderer_unavailable' }
    })
    const onOpenSession = vi.fn()
    const loaded = await mount(client, onOpenSession)
    expect(loaded.sessionTabsUnavailable).toBe(false)

    await act(async () => {
      await loaded.openInSession()
    })

    expect(onOpenSession).not.toHaveBeenCalled()
    expect(controller?.actionError).toBe(SESSION_TABS_UNAVAILABLE_MESSAGE)
    expect(controller?.sessionTabsUnavailable).toBe(true)
  })

  it('still returns to the session when a desktop host opens the diff tab', async () => {
    const { client, send } = clientAnsweringOpenDiff({
      id: 'request-1',
      ok: true,
      result: { opened: true }
    })
    const onOpenSession = vi.fn()
    const loaded = await mount(client, onOpenSession)

    await act(async () => {
      await loaded.openInSession()
    })

    expect(send.mock.calls.find(([method]) => method === 'files.openDiff')?.[1]).toMatchObject({
      worktree: 'id:wt-1',
      relativePath: 'src/app.ts',
      staged: false
    })
    expect(onOpenSession).toHaveBeenCalledTimes(1)
    expect(controller?.sessionTabsUnavailable).toBe(false)
  })
})
