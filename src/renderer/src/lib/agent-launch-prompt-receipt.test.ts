import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ReceiptState = {
  tabsByWorktree: Record<string, { id: string }[]>
  ptyIdsByTabId: Record<string, string[]>
  agentStatusByPaneKey: Record<string, { updatedAt: number }>
  settings: Record<string, unknown>
}

const mocks = vi.hoisted(() => {
  const empty = (): ReceiptState => ({
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    agentStatusByPaneKey: {},
    settings: {}
  })
  let state = empty()
  const listeners = new Set<(next: ReceiptState) => void>()
  return {
    getState: () => state,
    setState: (next: Partial<ReceiptState>) => {
      state = { ...state, ...next }
      for (const listener of listeners) {
        listener(state)
      }
    },
    subscribe: (listener: (next: ReceiptState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reset: () => {
      listeners.clear()
      state = empty()
    },
    readiness: vi.fn(),
    readForeground: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState, subscribe: mocks.subscribe }
}))
vi.mock('./agent-draft-readiness', () => ({ waitForAgentDraftInputReady: mocks.readiness }))
vi.mock('./agent-paste-draft', () => ({
  PTY_SPAWN_TIMEOUT_MS: 8000,
  getSettingsForAgentTabRuntimeOwner: () => ({})
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ isRemoteRuntimePtyId: () => false }))

import { waitForLaunchPromptReceipt } from './agent-launch-prompt-receipt'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function receipt() {
  return waitForLaunchPromptReceipt({ tabId: 'tab-1', agent: 'claude', launchedAt: 100 })
}

describe('whether a prompt that rode the launch command reached the agent', () => {
  beforeEach(() => {
    mocks.reset()
    mocks.setState({ tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] } })
    mocks.readiness.mockReset().mockResolvedValue(true)
    mocks.readForeground.mockReset().mockResolvedValue('agent')
    // Timers go through globalThis at call time, so fake timers reach them.
    vi.stubGlobal('window', {
      setTimeout: (handler: () => void, ms: number) => globalThis.setTimeout(handler, ms),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
      api: { pty: { readLaunchedAgentForeground: mocks.readForeground } }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('is delivered when the agent’s own hook reports a turn on the tab', async () => {
    mocks.readiness.mockReturnValue(new Promise(() => {}))
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    mocks.setState({ agentStatusByPaneKey: { [PANE]: { updatedAt: 150 } } })
    await expect(pending).resolves.toBe('delivered')
  })

  // Why: #24257's crash-guard predicate, asked once the agent looks ready.
  it('is delivered when a fresh read finds the launched agent in front', async () => {
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    await expect(pending).resolves.toBe('delivered')
    expect(mocks.readForeground).toHaveBeenCalledWith('pty-1', 'claude')
    expect(mocks.readiness.mock.calls[0]?.[4]).toEqual({ revokeOnBracketedPasteOff: true })
  })

  // Why: a shell back at its prompt looks ready too; readiness alone never counts.
  // Why: the agent had the prompt on its line and quit at startup, before reading it.
  it('reports the agent exited when the read finds the shell, however ready it looked', async () => {
    mocks.readForeground.mockResolvedValue('shell')
    mocks.setState({ agentStatusByPaneKey: { [PANE]: { updatedAt: 50 } } })
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    await expect(pending).resolves.toBe('agent-exited')
  })

  it('is unconfirmed when the host cannot tell and no hook turn arrives', async () => {
    vi.useFakeTimers()
    mocks.readForeground.mockResolvedValue('unknown')
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(pending).resolves.toBe('unconfirmed')
  })

  it('takes a hook turn that arrives after a read that could not tell', async () => {
    vi.useFakeTimers()
    mocks.readForeground.mockResolvedValue('unknown')
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    await vi.advanceTimersByTimeAsync(500)
    mocks.setState({ agentStatusByPaneKey: { [PANE]: { updatedAt: 600 } } })
    await expect(pending).resolves.toBe('delivered')
  })

  it('reports the agent exited when the PTY exits first', async () => {
    mocks.readiness.mockReturnValue(new Promise(() => {}))
    const pending = receipt()
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    mocks.setState({ ptyIdsByTabId: { 'tab-1': [] } })
    await expect(pending).resolves.toBe('agent-exited')
  })

  it('is not delivered when the PTY never spawns, as when the host refused its launch file', async () => {
    vi.useFakeTimers()
    const pending = receipt()
    await vi.advanceTimersByTimeAsync(8_000)
    await expect(pending).resolves.toBe('not-delivered')
    expect(mocks.readForeground).not.toHaveBeenCalled()
  })

  it('is not delivered when the tab closes first', async () => {
    const pending = receipt()
    mocks.setState({ tabsByWorktree: { 'wt-1': [] } })
    await expect(pending).resolves.toBe('not-delivered')
  })
})
