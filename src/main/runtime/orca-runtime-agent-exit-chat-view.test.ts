import { afterEach, describe, expect, it, vi } from 'vitest'
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
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'
import { settledWriteStub } from '../providers/settled-pty-write-stub'

const A = HEADLESS_LEAF_ID
const B = HEADLESS_SECOND_LEAF_ID
const PTY: Record<string, string> = { [A]: 'pty-a', [B]: 'pty-b' }

type Presence = 'live' | 'unverifiable' | 'exited' | null
const NO_CHILDREN: TerminalProcessInspection = {
  foregroundProcess: 'zsh',
  hasChildProcesses: false,
  childProcessEvidence: 'no-children'
}
const CHILDREN: TerminalProcessInspection = {
  foregroundProcess: 'claude',
  hasChildProcesses: true,
  childProcessEvidence: 'children'
}

function unifiedTab(viewMode?: 'terminal' | 'chat'): Tab {
  return {
    id: 'host-tab',
    entityId: 'host-tab',
    groupId: 'group-1',
    worktreeId: TEST_WORKTREE_ID,
    contentType: 'terminal',
    label: 'Persisted Terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...(viewMode ? { viewMode } : {})
  }
}

/** A headless host tab whose panes run PTYs launched as Claude; no renderer consumes facts. */
function makeExitHost(options: {
  viewMode?: 'terminal' | 'chat'
  leaves: 1 | 2
  chatLeafId?: string
  tabLaunchAgent?: 'claude'
  presence?: () => Promise<Presence>
  inspection?: () => Promise<TerminalProcessInspection>
}) {
  const ptyIds = options.leaves === 2 ? { [A]: PTY[A], [B]: PTY[B] } : { [A]: PTY[A] }
  const layout: TerminalLayoutSnapshot = {
    ...makeHeadlessTerminalLayout(ptyIds),
    ...(options.chatLeafId ? { chatLeafId: options.chatLeafId } : {})
  }
  const base = makeWorkspaceSessionWithHeadlessTerminal()
  const row = base.tabsByWorktree[TEST_WORKTREE_ID]![0]!
  const session = {
    ...base,
    tabsByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          ...row,
          ptyId: PTY[A]!,
          ...(options.tabLaunchAgent ? { launchAgent: options.tabLaunchAgent } : {})
        }
      ]
    },
    unifiedTabs: { [TEST_WORKTREE_ID]: [unifiedTab(options.viewMode)] },
    terminalLayoutsByTabId: { 'host-tab': layout }
  }
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements RuntimeStore; its annotation erases the Vitest mock call signatures.
  const store = runtimeStore as RuntimeStore
  const presence = vi.fn(options.presence ?? (async (): Promise<Presence> => null))
  const runtime = new OrcaRuntimeService(store, undefined, {
    checkHookAgentPresence: () => presence()
  })
  const write = vi.fn((_ptyId: string, _data: string) => true)
  const inspectProcess = vi.fn(options.inspection ?? (async () => NO_CHILDREN))
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: vi.fn(),
    getForegroundProcess: vi.fn(async () => null),
    inspectProcess
  })
  for (const leafId of Object.keys(ptyIds)) {
    runtime.registerPty(PTY[leafId]!, TEST_WORKTREE_ID, null, {
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
  const hostLaunchAgent = () => getSession().tabsByWorktree[TEST_WORKTREE_ID]?.[0]?.launchAgent
  const published = async () =>
    (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs.flatMap((tab) =>
      tab.type === 'terminal' ? [tab] : []
    )
  const snapshotVersion = () =>
    runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)?.snapshotVersion
  const writeCount = () => vi.mocked(store.setWorkspaceSession!).mock.calls.length
  const handleFor = (leafId: string): string => {
    const handle = runtime['handleByPtyId'].get(PTY[leafId]!)
    if (!handle) {
      throw new Error(`no handle for ${leafId}`)
    }
    return handle
  }
  const chatSend = (leafId: string, actionId: string, text = 'rm -rf build') =>
    runtime.sendTerminal(
      handleFor(leafId),
      { text, enter: true },
      { inputKind: 'driving', chatInput: { actionId } }
    )
  return {
    runtime,
    store,
    presence,
    inspectProcess,
    write,
    hostPair,
    hostLaunchAgent,
    published,
    snapshotVersion,
    writeCount,
    handleFor,
    chatSend
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('F2: the host turns a chat tab to terminal on a proven agent exit (headless)', () => {
  it('retires the owner pane chat and its launch hint when the hook owner check says exited', async () => {
    const host = makeExitHost({
      viewMode: 'chat',
      leaves: 1,
      tabLaunchAgent: 'claude',
      presence: async () => 'exited'
    })
    await host.published()
    const writes = host.writeCount()
    const version = host.snapshotVersion()!

    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await flush()

    expect(host.hostPair()).toEqual({ viewMode: 'terminal', owner: undefined })
    expect(host.hostLaunchAgent()).toBeUndefined()
    expect(host.writeCount()).toBe(writes + 1)
    expect(host.snapshotVersion()).toBeGreaterThan(version)
    const rows = await host.published()
    expect(rows.map((row) => [row.viewMode, row.launchAgent])).toEqual([['terminal', undefined]])
  })

  it('refuses a later composer send with zero bytes, while raw terminal input still writes', async () => {
    const host = makeExitHost({ viewMode: 'chat', leaves: 1, presence: async () => 'exited' })
    await host.published()
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await flush()
    host.write.mockClear()

    await expect(host.chatSend(A, 'after-exit')).resolves.toMatchObject({
      accepted: false,
      bytesWritten: 0,
      refusedReason: 'agent-exited'
    })
    expect(host.write).not.toHaveBeenCalled()

    await expect(
      host.runtime.sendTerminal(host.handleFor(A), { text: 'ls' }, { inputKind: 'driving' })
    ).resolves.toMatchObject({ accepted: true })
    expect(host.write).toHaveBeenCalledWith(PTY[A], 'ls', 'driving')
  })

  it('proves an exit from the execution host when no hook owner is identified', async () => {
    const host = makeExitHost({ viewMode: 'chat', leaves: 2, chatLeafId: A })
    await host.published()

    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await flush()

    expect(host.inspectProcess).toHaveBeenCalledWith(PTY[A], {
      expectedIncarnationId: `inc-${A}`,
      scanChildProcesses: true
    })
    expect(host.hostPair()).toEqual({ viewMode: 'terminal', owner: undefined })
  })

  it('treats a finished launch command (OSC 133;D) as a reason to look, then retires on proof', async () => {
    const host = makeExitHost({ viewMode: 'chat', leaves: 1 })
    await host.published()
    host.runtime['noteAgentSightedForExitProof'](PTY[A]!)

    host.runtime.onPtyData(PTY[A]!, '\x1b]133;D;0\x07', 1)
    await flush()

    expect(host.hostPair()).toEqual({ viewMode: 'terminal', owner: undefined })
  })

  it("leaves the tab alone when the exited agent is not the chat owner's", async () => {
    const host = makeExitHost({
      viewMode: 'chat',
      leaves: 2,
      chatLeafId: A,
      presence: async () => 'exited'
    })
    await host.published()
    const writes = host.writeCount()

    host.runtime['confirmPtyAgentExit'](PTY[B]!)
    await flush()

    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: A })
    expect(host.writeCount()).toBe(writes)
    await expect(host.chatSend(A, 'owner-still-live')).resolves.toMatchObject({ accepted: true })
  })

  it('discards an exit observation once new agent evidence arrives before it commits', async () => {
    let resolveInspection: (value: TerminalProcessInspection) => void = () => {}
    const host = makeExitHost({
      viewMode: 'chat',
      leaves: 1,
      inspection: () =>
        new Promise<TerminalProcessInspection>((resolve) => {
          resolveInspection = resolve
        })
    })
    await host.published()
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await flush()

    // A replacement agent on the same PTY incarnation reports itself before the proof lands.
    host.runtime['noteNativeChatAgentEvidence'](PTY[A]!)
    resolveInspection(NO_CHILDREN)
    await flush()

    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: undefined })
    await expect(host.chatSend(A, 'to-new-agent')).resolves.toMatchObject({ accepted: true })
  })
})

describe('F2: the host advertises that it owns exits', () => {
  it('stamps chatViewAgentExitHostOwned beside chatViewHostOwned on session-tabs results', async () => {
    const host = makeExitHost({ viewMode: 'chat', leaves: 1 })
    const result = await host.runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(result).toMatchObject({ chatViewHostOwned: true, chatViewAgentExitHostOwned: true })
    host.runtime['stopAgentExitReconcile']()
  })
})

describe('F2: weak or missing evidence never retires chat (narrow guard)', () => {
  it.each<[string, Presence, () => Promise<TerminalProcessInspection>]>([
    [
      'an identified owner whose process cannot be checked',
      'unverifiable',
      async () => NO_CHILDREN
    ],
    [
      'an SSH host the relay cannot reach (no identified owner)',
      null,
      async () => ({
        foregroundProcess: null,
        hasChildProcesses: false,
        verdict: 'unverifiable',
        reason: 'transport_loss'
      })
    ],
    [
      'a host read that throws',
      null,
      async () => {
        throw new Error('process_table_unreadable')
      }
    ],
    ['a running child (agent suspended or still alive)', null, async () => CHILDREN],
    ['a live hook owner', 'live', async () => NO_CHILDREN]
  ])('keeps chat and accepts sends for %s', async (_label, presence, inspection) => {
    const host = makeExitHost({
      viewMode: 'chat',
      leaves: 1,
      presence: async () => presence,
      inspection
    })
    await host.published()
    if (presence === 'unverifiable') {
      host.runtime['ptysById'].get(PTY[A]!)!.connected = false
    }

    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await flush()

    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: undefined })
    host.runtime['ptysById'].get(PTY[A]!)!.connected = true
    await expect(host.chatSend(A, 'still-agent')).resolves.toMatchObject({ accepted: true })
  })

  it('does not take an empty shell for an exit while a fresh launch may still be starting', async () => {
    vi.useFakeTimers()
    const host = makeExitHost({ viewMode: 'chat', leaves: 1 })
    await host.published()

    host.runtime['runAgentExitReconcilePass']()
    await vi.advanceTimersByTimeAsync(0)

    expect(host.inspectProcess).toHaveBeenCalled()
    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: undefined })
  })
})

describe('F2: bounded reconciliation finds exits nothing reported', () => {
  it('retires an unswitched sole-pane tab launched as Claude: hint cleared, view stays absent', async () => {
    vi.useFakeTimers()
    const host = makeExitHost({ leaves: 1, tabLaunchAgent: 'claude' })
    const before = await host.published()
    expect(before.map((row) => [row.viewMode, row.launchAgent])).toEqual([[undefined, 'claude']])
    expect(host.runtime['agentExitReconcileTimer']).not.toBeNull()

    // First pass records the candidate; past the launch grace an empty shell is proof.
    host.runtime['runAgentExitReconcilePass']()
    await vi.advanceTimersByTimeAsync(31_000)
    host.runtime['runAgentExitReconcilePass']()
    await vi.advanceTimersByTimeAsync(0)

    expect(host.hostPair().viewMode).toBeUndefined()
    expect(host.hostLaunchAgent()).toBeUndefined()
    // Why both absent: the phone resolver then answers terminal for an unswitched tab.
    const [row] = await host.published()
    expect([row?.viewMode, row?.launchAgent]).toEqual([undefined, undefined])
    await expect(host.chatSend(A, 'stale-composer')).resolves.toMatchObject({
      accepted: false,
      refusedReason: 'agent-exited'
    })

    host.runtime['runAgentExitReconcilePass']()
    expect(host.runtime['agentExitReconcileTimer']).toBeNull()
  })

  it('keeps an unswitched tab when its SSH host cannot be read', async () => {
    vi.useFakeTimers()
    const host = makeExitHost({
      leaves: 1,
      tabLaunchAgent: 'claude',
      inspection: async () => ({
        foregroundProcess: null,
        hasChildProcesses: false,
        verdict: 'unverifiable',
        reason: 'transport_loss'
      })
    })
    await host.published()
    host.runtime['runAgentExitReconcilePass']()
    await vi.advanceTimersByTimeAsync(31_000)
    host.runtime['runAgentExitReconcilePass']()
    await vi.advanceTimersByTimeAsync(0)

    expect(host.hostLaunchAgent()).toBe('claude')
    host.runtime['stopAgentExitReconcile']()
    // Why real timers: an accepted send waits out its body-to-Enter gap.
    vi.useRealTimers()
    await expect(host.chatSend(A, 'still-agent')).resolves.toMatchObject({ accepted: true })
  })
})

describe('F2: a proven exit cancels the in-flight chat action for good', () => {
  it('refuses the old Enter after the exit even when a new agent re-admits new actions', async () => {
    const host = makeExitHost({ viewMode: 'chat', leaves: 1, presence: async () => 'exited' })
    await host.published()
    await expect(
      host.runtime.writeNativeChatInputToPty(PTY[A]!, 'hello', 'driving', 'action-k')
    ).resolves.toMatchObject({ accepted: true })

    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await flush()
    host.runtime['noteNativeChatAgentEvidence'](PTY[A]!)
    host.write.mockClear()

    await expect(
      host.runtime.writeNativeChatInputToPty(PTY[A]!, '\r', 'driving', 'action-k')
    ).resolves.toEqual({ accepted: false, bytesWritten: 0, refusedReason: 'agent-exited' })
    expect(host.write).not.toHaveBeenCalled()
    await expect(
      host.runtime.writeNativeChatInputToPty(PTY[A]!, 'next', 'driving', 'action-new')
    ).resolves.toMatchObject({ accepted: true })
  })
})

describe('F2: a desktop-owned host relays a conditional exit write', () => {
  it('asks the renderer to retire only that pane, bound to that PTY', async () => {
    const host = makeExitHost({
      viewMode: 'chat',
      leaves: 2,
      chatLeafId: A,
      presence: async () => 'exited'
    })
    await host.published()
    const setTerminalChatView = vi.fn(async () => ({ viewMode: 'terminal', chatLeafId: null }))
    Reflect.set(host.runtime, 'getAvailableAuthoritativeWindow', () => ({}))
    Reflect.set(host.runtime, 'notifier', { setTerminalChatView })
    const writes = host.writeCount()

    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await flush()

    expect(setTerminalChatView).toHaveBeenCalledTimes(1)
    expect(setTerminalChatView).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      'host-tab',
      A,
      'terminal',
      undefined,
      { ptyId: PTY[A] }
    )
    // Why: the renderer owns a desktop host's tabs; main never writes its own copy.
    expect(host.writeCount()).toBe(writes)
  })

  it('still refuses composer sends when the renderer relay fails', async () => {
    const host = makeExitHost({ viewMode: 'chat', leaves: 1, presence: async () => 'exited' })
    await host.published()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Reflect.set(host.runtime, 'getAvailableAuthoritativeWindow', () => ({}))
    Reflect.set(host.runtime, 'notifier', {
      setTerminalChatView: vi.fn(async () => {
        throw new Error('renderer_unavailable')
      })
    })

    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await flush()

    await expect(host.chatSend(A, 'after-exit')).resolves.toMatchObject({
      refusedReason: 'agent-exited'
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
