import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TerminalCommandStateModule from './terminal-command-state'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(
    (_worktreeId: string, _groupId?: string, _type?: string, options?: { id?: string }) => ({
      id: options?.id ?? 'tab-new',
      title: 'Terminal'
    })
  ),
  setActiveTabType: vi.fn(),
  setActiveTab: vi.fn(),
  activateWorktree: vi.fn(),
  focusTab: vi.fn(),
  persistOrder: vi.fn(),
  backgroundMount: vi.fn(),
  replyTerminalCreate: vi.fn()
}))

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({
      tabsByWorktree: {},
      settings: {},
      terminalLayoutsByTabId: {},
      createTab: mocks.createTab,
      setActiveTabType: mocks.setActiveTabType,
      setActiveTab: mocks.setActiveTab,
      revealWorktreeInSidebar: vi.fn(),
      setTabCustomTitle: vi.fn(),
      registerAgentLaunchConfig: vi.fn(),
      clearAgentLaunchConfig: vi.fn(),
      updateTabPtyId: vi.fn(),
      setTabLayout: vi.fn()
    })
  }
}))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mocks.backgroundMount
}))
vi.mock('@/lib/terminal-tab-for-pty-id', () => ({
  resolveTerminalTabPtyOwnership: () => ({ kind: 'none' })
}))
vi.mock('@/lib/terminal-reveal-identity', () => ({ verifyTerminalRevealIdentity: () => undefined }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/launch-agent-tab-order', () => ({ persistAgentLaunchTabOrder: mocks.persistOrder }))
vi.mock('./terminal-command-state', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalCommandStateModule>()),
  activateTerminalInitiatedWorktree: mocks.activateWorktree,
  focusTerminalInitiatedTab: mocks.focusTab
}))

import { registerTerminalPresentationIpcBridge } from './terminal-presentation-ipc-bridge'
import {
  agentLaunchTabReservationCountForTests,
  reserveAgentLaunchTab
} from '@/lib/agent-launch-tab-reservations'

type RevealListener = (request: Record<string, unknown>) => void
let reveal: RevealListener
const releases: (() => void)[] = []

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: {
      ui: {
        onCreateTerminal: (listener: RevealListener) => {
          reveal = listener
          return () => {}
        },
        onRequestTerminalTabMount: () => () => {},
        replyTerminalCreate: mocks.replyTerminalCreate
      }
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  })
  registerTerminalPresentationIpcBridge([])
})

afterEach(() => {
  releases.splice(0).forEach((release) => release())
  vi.unstubAllGlobals()
})

/** What main sends for a tab an `agent.launch` created: a background reveal with the minted ids. */
function hostReveal(tabId: string): Record<string, unknown> {
  return {
    requestId: 'req-1',
    worktreeId: 'wt-1',
    ptyId: 'pty-1',
    launchAgent: 'claude',
    activate: false,
    tabId,
    leafId: 'leaf-1'
  }
}

describe('revealing a tab an agent launch reserved', () => {
  it('places it in the button’s group, focuses it and reports it revealed', () => {
    const onRevealed = vi.fn()
    releases.push(
      reserveAgentLaunchTab('tab-reserved', {
        worktreeId: 'wt-1',
        groupId: 'group-2',
        focus: true,
        viewMode: 'terminal',
        onRevealed
      })
    )

    reveal(hostReveal('tab-reserved'))

    expect(mocks.createTab).toHaveBeenCalledWith(
      'wt-1',
      'group-2',
      undefined,
      expect.objectContaining({ id: 'tab-reserved', activate: true, viewMode: 'terminal' })
    )
    expect(mocks.activateWorktree).toHaveBeenCalled()
    expect(mocks.setActiveTab).toHaveBeenCalledWith('tab-reserved')
    expect(mocks.focusTab).toHaveBeenCalledWith('tab-reserved', 'leaf-1', 'wt-1')
    expect(mocks.persistOrder).toHaveBeenCalledWith('wt-1', 'tab-reserved')
    expect(onRevealed).toHaveBeenCalledWith('tab-reserved')
    expect(agentLaunchTabReservationCountForTests()).toBe(0)
  })

  it('keeps the host’s default placement for a tab nobody reserved', () => {
    reveal(hostReveal('tab-unreserved'))

    expect(mocks.createTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ id: 'tab-unreserved', activate: false })
    )
    expect(mocks.setActiveTab).not.toHaveBeenCalled()
    expect(mocks.persistOrder).not.toHaveBeenCalled()
  })

  it('still answers the host when the launch’s own callback throws', () => {
    releases.push(
      reserveAgentLaunchTab('tab-reserved', {
        worktreeId: 'wt-1',
        focus: true,
        onRevealed: () => {
          throw new Error('caller bookkeeping failed')
        }
      })
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    reveal(hostReveal('tab-reserved'))

    expect(mocks.replyTerminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1', tabId: 'tab-reserved' })
    )
    expect(mocks.replyTerminalCreate.mock.calls[0]?.[0]).not.toHaveProperty('error')
  })
})
