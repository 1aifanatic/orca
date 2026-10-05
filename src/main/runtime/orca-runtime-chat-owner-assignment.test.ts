import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { RuntimeStore } from './runtime-store-contract'
import type { Tab } from '../../shared/tab-types'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'

const A = HEADLESS_LEAF_ID
const B = HEADLESS_SECOND_LEAF_ID

const UNIFIED_HOST_TAB: Tab = {
  id: 'host-tab',
  entityId: 'host-tab',
  groupId: 'group-1',
  worktreeId: TEST_WORKTREE_ID,
  contentType: 'terminal',
  label: 'Persisted Terminal',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

/** A headless host tab; `agentOn` leaves get a PTY whose launch record names a supported agent. */
function makeOwnerHost(options: {
  viewMode?: 'terminal' | 'chat'
  leaves: 1 | 2
  activeLeafId?: string
  agentOn?: string[]
  chatLeafId?: string
}) {
  const ptyIds: Record<string, string> = { [A]: 'pty-a', [B]: 'pty-b' }
  const layout: TerminalLayoutSnapshot = {
    ...makeHeadlessTerminalLayout(
      options.leaves === 2 ? { [A]: ptyIds[A], [B]: ptyIds[B] } : { [A]: ptyIds[A] }
    ),
    activeLeafId: options.activeLeafId ?? (options.leaves === 2 ? B : A),
    ...(options.chatLeafId ? { chatLeafId: options.chatLeafId } : {})
  }
  const base = makeWorkspaceSessionWithHeadlessTerminal()
  const session = {
    ...base,
    unifiedTabs: {
      [TEST_WORKTREE_ID]: [
        { ...UNIFIED_HOST_TAB, ...(options.viewMode ? { viewMode: options.viewMode } : {}) }
      ]
    },
    terminalLayoutsByTabId: { 'host-tab': layout }
  }
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements RuntimeStore; its annotation erases the Vitest mock call signatures.
  const store = runtimeStore as RuntimeStore
  const runtime = new OrcaRuntimeService(store)
  for (const leafId of options.agentOn ?? []) {
    runtime.registerPty(ptyIds[leafId]!, TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId,
      incarnationId: `inc-${leafId}`,
      agentLaunchAuthority: { launchToken: `token-${leafId}`, launchAgent: 'claude' }
    })
  }
  const hostPair = () => ({
    viewMode: getSession().unifiedTabs?.[TEST_WORKTREE_ID]?.[0]?.viewMode,
    owner: getSession().terminalLayoutsByTabId['host-tab']?.chatLeafId
  })
  const publishedPairs = async () =>
    (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs.flatMap((tab) =>
      tab.type === 'terminal'
        ? [{ viewMode: tab.viewMode, owner: tab.parentLayout?.chatLeafId }]
        : []
    )
  const snapshotVersion = () =>
    runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)?.snapshotVersion
  const writeCount = () => vi.mocked(store.setWorkspaceSession!).mock.calls.length
  return { runtime, store, getSession, hostPair, publishedPairs, snapshotVersion, writeCount }
}

describe('F1: a parent-addressed chat on a split gets a host owner (headless)', () => {
  it('owns chat on the agent pane, not the active shell, in one write and one snapshot', async () => {
    const host = makeOwnerHost({ leaves: 2, activeLeafId: B, agentOn: [A] })
    await host.publishedPairs()
    const writes = host.writeCount()
    const version = host.snapshotVersion()!

    const reply = await host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat'
    })

    expect(reply.chatView).toEqual({ viewMode: 'chat', chatLeafId: A })
    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: A })
    expect(host.writeCount()).toBe(writes + 1)
    expect(host.snapshotVersion()).toBe(version + 1)
    expect(await host.publishedPairs()).toEqual([
      { viewMode: 'chat', owner: A },
      { viewMode: 'chat', owner: A }
    ])
  })

  it('prefers the active pane when it runs an agent', async () => {
    const host = makeOwnerHost({ leaves: 2, activeLeafId: B, agentOn: [A, B] })
    const reply = await host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat'
    })
    expect(reply.chatView).toEqual({ viewMode: 'chat', chatLeafId: B })
  })

  it('changes nothing when no pane of the split runs an agent', async () => {
    const host = makeOwnerHost({ leaves: 2, viewMode: 'terminal' })
    await host.publishedPairs()
    const writes = host.writeCount()
    const version = host.snapshotVersion()

    const reply = await host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat'
    })

    expect(reply.chatView).toEqual({ viewMode: 'terminal', chatLeafId: null })
    expect(host.hostPair()).toEqual({ viewMode: 'terminal', owner: undefined })
    expect(host.writeCount()).toBe(writes)
    expect(host.snapshotVersion()).toBe(version)
  })

  it('gives a sole pane the owner id even without agent evidence', async () => {
    const host = makeOwnerHost({ leaves: 1 })
    const reply = await host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat'
    })
    expect(reply.chatView).toEqual({ viewMode: 'chat', chatLeafId: A })
  })
})

describe('F1: an accepted layout push that grows an ownerless single-pane chat', () => {
  it('pins the pre-split pane, even when the push names the new pane', async () => {
    const host = makeOwnerHost({ leaves: 1, viewMode: 'chat' })
    await host.runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: A },
        second: { type: 'leaf', leafId: B }
      },
      expandedLeafId: null,
      chatLeafId: B
    })
    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: A })
  })

  it('never pins a terminal tab or moves an existing owner', async () => {
    const grown = {
      type: 'split' as const,
      direction: 'vertical' as const,
      first: { type: 'leaf' as const, leafId: A },
      second: { type: 'leaf' as const, leafId: B }
    }
    const terminal = makeOwnerHost({ leaves: 1, viewMode: 'terminal' })
    await terminal.runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      root: grown,
      expandedLeafId: null
    })
    expect(terminal.hostPair().owner).toBeUndefined()

    const owned = makeOwnerHost({ leaves: 2, viewMode: 'chat', chatLeafId: B })
    await owned.runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      root: grown,
      expandedLeafId: null,
      chatLeafId: A
    })
    expect(owned.hostPair()).toEqual({ viewMode: 'chat', owner: B })
  })
})

describe('F1: hydration repairs an ownerless chat with two or more panes once', () => {
  it('stores the agent pane as owner and writes once', async () => {
    const host = makeOwnerHost({ leaves: 2, viewMode: 'chat', activeLeafId: B, agentOn: [A] })
    const writes = host.writeCount()

    expect(await host.publishedPairs()).toEqual([
      { viewMode: 'chat', owner: A },
      { viewMode: 'chat', owner: A }
    ])
    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: A })
    expect(host.writeCount()).toBe(writes + 1)

    host.runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    host.runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    expect(host.writeCount()).toBe(writes + 1)
  })

  it('turns the tab terminal when no pane may own chat', async () => {
    const host = makeOwnerHost({ leaves: 2, viewMode: 'chat' })
    expect(await host.publishedPairs()).toEqual([
      { viewMode: 'terminal', owner: undefined },
      { viewMode: 'terminal', owner: undefined }
    ])
    expect(host.hostPair()).toEqual({ viewMode: 'terminal', owner: undefined })
  })

  it('leaves absent view modes, single panes and stored owners alone', async () => {
    for (const host of [
      makeOwnerHost({ leaves: 2, agentOn: [A] }),
      makeOwnerHost({ leaves: 1, viewMode: 'chat' }),
      makeOwnerHost({ leaves: 2, viewMode: 'chat', chatLeafId: 'gone', agentOn: [A] })
    ]) {
      const before = host.hostPair()
      const writes = host.writeCount()
      await host.publishedPairs()
      expect(host.hostPair()).toEqual(before)
      expect(host.writeCount()).toBe(writes)
    }
  })
})

describe('F1: a desktop-owned host relays its owner pick', () => {
  const relayHost = (options: Parameters<typeof makeOwnerHost>[0]) => {
    const host = makeOwnerHost(options)
    const setTerminalChatView = vi.fn(async () => ({ viewMode: 'chat', chatLeafId: A }))
    return { host, setTerminalChatView }
  }
  const attachDesktop = (
    host: ReturnType<typeof makeOwnerHost>,
    setTerminalChatView: ReturnType<typeof vi.fn>
  ) => {
    Reflect.set(host.runtime, 'getAvailableAuthoritativeWindow', () => ({}))
    Reflect.set(host.runtime, 'notifier', { setTerminalChatView })
  }
  const write = (host: ReturnType<typeof makeOwnerHost>, seq: number) =>
    host.runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat',
      chatViewWrite: { writerId: 'W', seq }
    })

  it('sends the agent pane as the fallback owner of a parent-addressed chat', async () => {
    const { host, setTerminalChatView } = relayHost({ leaves: 2, activeLeafId: B, agentOn: [A] })
    await host.publishedPairs()
    attachDesktop(host, setTerminalChatView)

    await write(host, 1)

    expect(setTerminalChatView).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'host-tab', null, 'chat', A)
  })

  it('relays nothing and answers the current pair when no pane runs an agent', async () => {
    const { host, setTerminalChatView } = relayHost({ leaves: 2, viewMode: 'terminal' })
    await host.publishedPairs()
    attachDesktop(host, setTerminalChatView)

    const reply = await write(host, 1)

    expect(setTerminalChatView).not.toHaveBeenCalled()
    expect(reply.chatView).toEqual({ viewMode: 'terminal', chatLeafId: null })
  })

  it('sends no pick while the published pair already has a valid owner', async () => {
    const { host, setTerminalChatView } = relayHost({
      leaves: 2,
      viewMode: 'chat',
      chatLeafId: B,
      agentOn: [A]
    })
    await host.publishedPairs()
    attachDesktop(host, setTerminalChatView)

    await write(host, 1)

    expect(setTerminalChatView).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'host-tab', null, 'chat')
  })
})
