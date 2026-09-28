import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  makeCreatedAgentWorktree as makeWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/worktree-activation-created-agent-test-state'
import {
  createMockStore,
  registerWorktreeActivationReset
} from './worktree-activation-test-harness'

const openDefaultChat = vi.hoisted(() => vi.fn())

vi.mock('@/lib/empty-workspace-default-agent-chat', () => ({
  openDefaultAgentChatInEmptyWorkspace: openDefaultChat
}))

const initialAppStoreState = useAppStore.getState()

registerWorktreeActivationReset()

beforeEach(() => {
  openDefaultChat.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialAppStoreState, true)
})

// Why: with chat as the default view, clicking an empty workspace used to open a bare shell the
// user then had to turn into a chat by hand.
describe('empty workspace seeding with a default agent chat', () => {
  it('opens the default agent chat instead of a shell', () => {
    openDefaultChat.mockReturnValue({ primaryTabId: 'chat-tab' })
    const createTab = vi.fn(() => ({ id: 'shell-tab' }))
    const store = createMockStore({ createTab })

    const primaryTabId = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      undefined,
      undefined,
      undefined,
      { seedUserDefaultSurface: true }
    )

    expect(openDefaultChat).toHaveBeenCalledWith('wt-1')
    expect(primaryTabId).toBe('chat-tab')
    expect(createTab).not.toHaveBeenCalled()
  })

  it('falls back to a shell when no chat can open', () => {
    openDefaultChat.mockReturnValue(null)
    const createTab = vi.fn(() => ({ id: 'shell-tab' }))
    const store = createMockStore({ createTab })

    const primaryTabId = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      undefined,
      undefined,
      undefined,
      { seedUserDefaultSurface: true }
    )

    expect(primaryTabId).toBe('shell-tab')
    expect(createTab).toHaveBeenCalledTimes(1)
  })

  it('keeps the shell for seeds that did not ask for the default surface', () => {
    const store = createMockStore({ createTab: vi.fn(() => ({ id: 'shell-tab' })) })

    ensureWorktreeHasInitialTerminal(store, 'wt-1')
    ensureWorktreeHasInitialTerminal(store, 'wt-2', undefined, undefined, undefined, undefined, {
      seedUserDefaultSurface: true,
      activateCreatedTabs: false
    })

    expect(openDefaultChat).not.toHaveBeenCalled()
  })

  it('plain navigation to an empty workspace asks for the default surface', () => {
    openDefaultChat.mockReturnValue({ primaryTabId: null })
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)

    activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })

    expect(openDefaultChat).toHaveBeenCalledWith(worktree.id)
  })

  it('a Blank Terminal pick or a target directory keeps the shell', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)

    activateAndRevealWorktree(worktree.id, { agent: null, notifyHostRuntime: false })
    expect(openDefaultChat).not.toHaveBeenCalled()

    useAppStore.setState(initialAppStoreState, true)
    seedEmptyActivatableWorktree(worktree)
    activateAndRevealWorktree(worktree.id, {
      initialCwd: `${worktree.path}/packages/app`,
      notifyHostRuntime: false
    })
    expect(openDefaultChat).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(1)
  })
})
