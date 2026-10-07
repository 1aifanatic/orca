import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  resetAgentLaunchPanesForTests,
  trackRunningAgentLaunchPane
} from '../agent-launch/agent-launch-pane-attachment'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, callback),
    on: vi.fn()
  }
}))
import { registerSessionHandlers } from './session'

const WT = 'repo1::/tmp/feature'
const TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const OTHER_LEAF = '6fa459ea-ee8a-4ca4-894e-db77e160355e'

let committed = false
const closeTerminalSurfaceFromRenderer = vi.fn(async () => {
  await Promise.resolve()
  committed = true
})
// Names the push only once the close has committed.
const settleTerminalTopology = vi.fn(() => (committed ? 7 : 0))

function closeSurface(args: unknown): unknown {
  return mocks.handlers.get('session:close-terminal-surface')?.({}, args)
}

function launchIn(leafId: string) {
  return trackRunningAgentLaunchPane({ worktreeId: WT, paneKey: makePaneKey(TAB, leafId) })
}

beforeEach(() => {
  mocks.handlers.clear()
  closeTerminalSurfaceFromRenderer.mockClear()
  committed = false
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler under test reaches only the runtime's renderer close and topology settle.
  const runtime = { closeTerminalSurfaceFromRenderer, settleTerminalTopology } as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close handler never touches the store.
  registerSessionHandlers({} as never, runtime)
})

afterEach(() => {
  resetAgentLaunchPanesForTests()
})

describe("the user's close of a launch's tab or pane", () => {
  it('stops a launch still running in the tab the user closed', async () => {
    const running = launchIn(LEAF)

    await closeSurface({ worktreeId: WT, target: { kind: 'tab', tabId: TAB }, reason: 'user' })

    expect(running.closedByUser()).toBe(true)
    expect(closeTerminalSurfaceFromRenderer).toHaveBeenCalledWith({
      worktreeId: WT,
      target: { kind: 'tab', tabId: TAB },
      reason: 'user'
    })
  })

  it('stops only the launch in the pane the user closed, not a split beside it', async () => {
    const closed = launchIn(LEAF)
    const kept = launchIn(OTHER_LEAF)

    await closeSurface({
      worktreeId: WT,
      target: { kind: 'pane', tabId: TAB, leafId: LEAF },
      reason: 'user'
    })

    expect(closed.closedByUser()).toBe(true)
    expect(kept.closedByUser()).toBe(false)
  })

  it('is not the user stopping it when the host tidies the tab away', async () => {
    const running = launchIn(LEAF)

    await closeSurface({ worktreeId: WT, target: { kind: 'tab', tabId: TAB }, reason: 'cleanup' })

    expect(running.closedByUser()).toBe(false)
  })

  it("never touches another workspace's launch", async () => {
    const running = launchIn(LEAF)

    await closeSurface({
      worktreeId: 'repo1::/tmp/other',
      target: { kind: 'tab', tabId: TAB },
      reason: 'user'
    })

    expect(running.closedByUser()).toBe(false)
  })

  it('replies with the publishSeq of the push that carries the close', async () => {
    await expect(
      closeSurface({ worktreeId: WT, target: { kind: 'tab', tabId: TAB }, reason: 'user' })
    ).resolves.toEqual({ publishSeq: 7 })
    expect(settleTerminalTopology).toHaveBeenLastCalledWith(WT)
  })
})
