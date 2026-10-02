import { beforeEach, describe, expect, it, vi } from 'vitest'

type ReceiptState = {
  tabsByWorktree: Record<string, { id: string }[]>
  ptyIdsByTabId: Record<string, string[]>
  agentStatusByPaneKey: Record<string, { updatedAt: number }>
  settings: Record<string, unknown>
}

const mocks = vi.hoisted(() => {
  let state: ReceiptState = {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    agentStatusByPaneKey: {},
    settings: {}
  }
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
      state = { tabsByWorktree: {}, ptyIdsByTabId: {}, agentStatusByPaneKey: {}, settings: {} }
    },
    readiness: vi.fn(),
    waitForAgentReady: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState, subscribe: mocks.subscribe }
}))
vi.mock('./agent-paste-draft', () => ({
  PTY_SPAWN_TIMEOUT_MS: 8000,
  getSettingsForAgentTabRuntimeOwner: () => ({}),
  waitForAgentDraftInputReadyOnTab: mocks.readiness
}))
vi.mock('./agent-ready-wait', () => ({ waitForAgentReady: mocks.waitForAgentReady }))

import { waitForLaunchPromptReceipt } from './agent-launch-prompt-receipt'

const never = (): Promise<never> => new Promise(() => {})

describe('whether a prompt that rode the launch command reached the agent', () => {
  beforeEach(() => {
    mocks.reset()
    mocks.setState({ tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] } })
    mocks.readiness.mockReset().mockImplementation(never)
    mocks.waitForAgentReady.mockReset()
  })

  it('is delivered when the agent’s own hook reports a turn on the tab', async () => {
    const receipt = waitForLaunchPromptReceipt({ tabId: 'tab-1', agent: 'claude', launchedAt: 100 })
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    mocks.setState({
      agentStatusByPaneKey: { 'tab-1:11111111-1111-4111-8111-111111111111': { updatedAt: 150 } }
    })
    await expect(receipt).resolves.toBe(true)
  })

  it('ignores a status row older than the launch', async () => {
    mocks.setState({
      agentStatusByPaneKey: { 'tab-1:11111111-1111-4111-8111-111111111111': { updatedAt: 50 } }
    })
    mocks.readiness.mockResolvedValue(null)
    const receipt = waitForLaunchPromptReceipt({ tabId: 'tab-1', agent: 'claude', launchedAt: 100 })
    await expect(receipt).resolves.toBe(false)
  })

  it('is not delivered when the PTY exits before the agent shows any sign of the prompt', async () => {
    const receipt = waitForLaunchPromptReceipt({ tabId: 'tab-1', agent: 'claude', launchedAt: 100 })
    mocks.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } })
    mocks.setState({ ptyIdsByTabId: { 'tab-1': [] } })
    await expect(receipt).resolves.toBe(false)
  })

  it('is not delivered when the PTY never spawns, as when the host refused its launch file', async () => {
    mocks.readiness.mockResolvedValue(null)
    const receipt = waitForLaunchPromptReceipt({ tabId: 'tab-1', agent: 'codex', launchedAt: 100 })
    await expect(receipt).resolves.toBe(false)
  })

  it('is delivered when the agent shows the composer a paste would have waited for', async () => {
    mocks.readiness.mockResolvedValue({ ptyId: 'pty-1', ready: true })
    const receipt = waitForLaunchPromptReceipt({ tabId: 'tab-1', agent: 'codex', launchedAt: 100 })
    await expect(receipt).resolves.toBe(true)
  })

  it('reports an unconfirmed delivery when only the agent process was seen', async () => {
    mocks.readiness.mockResolvedValue({ ptyId: 'pty-1', ready: false })
    mocks.waitForAgentReady.mockResolvedValue({ ready: true, reason: 'foreground-match' })
    const onUnconfirmedDelivery = vi.fn()
    const receipt = waitForLaunchPromptReceipt({
      tabId: 'tab-1',
      agent: 'codex',
      launchedAt: 100,
      onUnconfirmedDelivery
    })
    await expect(receipt).resolves.toBe(true)
    expect(onUnconfirmedDelivery).toHaveBeenCalledOnce()
  })

  it('is not delivered when the tab closes first', async () => {
    const receipt = waitForLaunchPromptReceipt({ tabId: 'tab-1', agent: 'claude', launchedAt: 100 })
    mocks.setState({ tabsByWorktree: { 'wt-1': [] } })
    await expect(receipt).resolves.toBe(false)
  })
})
