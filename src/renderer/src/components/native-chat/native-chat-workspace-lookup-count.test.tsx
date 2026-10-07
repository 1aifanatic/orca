// @vitest-environment happy-dom

// Lookup-count gate for STA-9590: a mounted native chat, its composer hooks and its action paths
// read only their own workspace's tab bucket, however many other workspaces exist. Real store
// publications drive the selectors; an old-scan control proves the counter sees a global search.

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import type * as SessionOptionDiscoveryModule from './native-chat-session-option-discovery'

vi.mock('@/runtime/runtime-file-client', async () => {
  const mocks = await import('../__mocks__/quick-open-runtime-file-client')
  return {
    listRuntimeFiles: mocks.listRuntimeFilesMock,
    cancelRuntimeFileList: mocks.cancelRuntimeFileListMock,
    searchRuntimeFilePaths: mocks.searchRuntimeFilePathsMock
  }
})
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  callRuntimeRpc: vi.fn(async () => ({ skills: [], sources: [] }))
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: vi.fn(),
  isRemoteRuntimePtyId: () => false
}))
vi.mock('@/runtime/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: vi.fn(async () => true)
}))
vi.mock('./native-chat-session-option-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionOptionDiscoveryModule>()),
  discoverNativeChatCatalogModels: vi.fn(async () => null)
}))

import { useAppStore } from '@/store'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import {
  searchRuntimeFilePathsMock,
  listRuntimeFilesMock
} from '../__mocks__/quick-open-runtime-file-client'
import { makeRemoteWorktree, initialAppState } from '../quick-open-file-list-test-harness'
import {
  selectNativeChatBridgeMembership,
  selectNativeChatRuntimeEnvironmentId
} from './native-chat-runtime-owner'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { useNativeChatImageRuntimeContext } from './native-chat-image-runtime-context'
import { useNativeChatSkills } from './use-native-chat-skills'
import { useNativeChatMentionFiles } from './use-native-chat-mention-files'
import { useNativeChatSessionOptions } from './use-native-chat-session-options'
import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import { resolveNativeChatAttachmentOwner } from './native-chat-attachment-upload'
import { resolveNativeChatModelDiscoveryContext } from './native-chat-session-option-discovery'
import {
  resolveNativeChatBridgeRuntimeSettings,
  type NativeChatBridgeTabScope,
  type NativeChatTabScope
} from './native-chat-tab-scope'

const OWN = 'wt-remote'
const CHAT_TAB = 'chat-tab'

type Counter = { foreignReads: number; enumerations: number; anyReads: number }

const counters: { terminal: Counter; unified: Counter } = {
  terminal: { foreignReads: 0, enumerations: 0, anyReads: 0 },
  unified: { foreignReads: 0, enumerations: 0, anyReads: 0 }
}

function resetCounters(): void {
  for (const counter of Object.values(counters)) {
    counter.foreignReads = 0
    counter.enumerations = 0
    counter.anyReads = 0
  }
}

/** Counts reads of other workspaces' buckets and any enumeration of the map itself. */
function counted<T extends object>(map: Record<string, T>, counter: Counter): Record<string, T> {
  return new Proxy(map, {
    get(target, key, receiver) {
      if (typeof key === 'string' && Object.hasOwn(target, key)) {
        counter.anyReads += 1
        if (key !== OWN) {
          counter.foreignReads += 1
        }
      }
      return Reflect.get(target, key, receiver)
    },
    ownKeys(target) {
      counter.enumerations += 1
      return Reflect.ownKeys(target)
    }
  })
}

function terminalTab(id: string, worktreeId: string, title = 'Terminal'): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function sessionTab(id: string, worktreeId: string): Tab {
  return {
    id,
    worktreeId,
    groupId: 'group',
    contentType: 'agent-session',
    entityId: `session-${id}`,
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    isPinned: false,
    agentSessionAgent: 'codex'
  }
}

type Buckets = {
  tabsByWorktree: AppState['tabsByWorktree']
  unifiedTabsByWorktree: AppState['unifiedTabsByWorktree']
}

/** The chat's own bucket held fixed while unrelated workspaces scale. */
function buckets(unrelated: number, ownChat: 'bridge' | 'structured'): Buckets {
  const tabsByWorktree: AppState['tabsByWorktree'] = {}
  const unifiedTabsByWorktree: AppState['unifiedTabsByWorktree'] = {}
  for (let index = 0; index < unrelated; index += 1) {
    const worktreeId = `wt-${index}`
    // Why the colliding id: a global search would find this row before reaching the owner.
    tabsByWorktree[worktreeId] = [
      terminalTab(CHAT_TAB, worktreeId),
      terminalTab(`t-${index}`, worktreeId)
    ]
    unifiedTabsByWorktree[worktreeId] = [sessionTab(`s-${index}`, worktreeId)]
  }
  tabsByWorktree[OWN] = ownChat === 'bridge' ? [terminalTab(CHAT_TAB, OWN)] : []
  unifiedTabsByWorktree[OWN] = ownChat === 'structured' ? [sessionTab(CHAT_TAB, OWN)] : []
  return { tabsByWorktree, unifiedTabsByWorktree }
}

function publishBuckets(next: Buckets): void {
  useAppStore.setState({
    tabsByWorktree: counted(next.tabsByWorktree, counters.terminal),
    unifiedTabsByWorktree: counted(next.unifiedTabsByWorktree, counters.unified)
  })
}

function seed(unrelated: number, ownChat: 'bridge' | 'structured'): Buckets {
  const worktree = makeRemoteWorktree()
  useAppStore.setState({
    ...initialAppState,
    settings: { ...initialAppState.settings!, activeRuntimeEnvironmentId: 'env-1' },
    repos: [],
    worktreesByRepo: { 'repo-remote': [worktree] },
    structuredSessionLaunchDirectoryByTabId: {}
  })
  const initial = buckets(unrelated, ownChat)
  publishBuckets(initial)
  return initial
}

/** Unrelated status pings, an unrelated tab's retitle, and a retitle of the chat's own row. */
function replayUnrelatedPublications(current: Buckets, ownChat: 'bridge' | 'structured'): void {
  for (let index = 0; index < 20; index += 1) {
    // Published as the hook server's rows land; the status producer's own work is not chat's.
    const paneKey = `t-${index}:leaf`
    const entry: AgentStatusEntry = {
      state: 'working',
      prompt: 'p',
      updatedAt: index,
      stateStartedAt: index,
      agentType: 'claude',
      paneKey,
      stateHistory: []
    }
    act(() => {
      useAppStore.setState((state) => ({
        agentStatusByPaneKey: { ...state.agentStatusByPaneKey, [paneKey]: entry }
      }))
    })
  }
  act(() =>
    publishBuckets({
      ...current,
      tabsByWorktree: {
        ...current.tabsByWorktree,
        'wt-0': [terminalTab('t-0', 'wt-0', 'Renamed elsewhere')]
      }
    })
  )
  if (ownChat === 'bridge') {
    act(() =>
      publishBuckets({
        ...current,
        tabsByWorktree: {
          ...current.tabsByWorktree,
          [OWN]: [terminalTab(CHAT_TAB, OWN, 'Renamed')]
        }
      })
    )
  }
}

type BridgeProbeApi = {
  member: boolean
  owner: string | null
  send: ReturnType<typeof useNativeChatInteractiveSend>
}
let bridgeApi: BridgeProbeApi | null = null

function BridgeChatProbe({
  scope,
  skillsOpen,
  mentionQuery
}: {
  scope: NativeChatBridgeTabScope
  skillsOpen: boolean
  mentionQuery: string | null
}): null {
  const member = useAppStore((state) => selectNativeChatBridgeMembership(state, scope))
  const owner = useAppStore((state) =>
    selectNativeChatRuntimeEnvironmentId(state, scope.worktreeId)
  )
  useNativeChatFileLinkContext(scope)
  useNativeChatImageRuntimeContext(scope)
  useNativeChatSkills('codex', scope, skillsOpen)
  useNativeChatMentionFiles({ query: mentionQuery, scope })
  useNativeChatSessionOptions({
    agent: 'codex',
    scope,
    targetPtyId: 'pty-1',
    dispatchCommand: vi.fn()
  })
  const send = useNativeChatInteractiveSend(scope, `${CHAT_TAB}:leaf`, 'pty-1', 'codex')
  bridgeApi = { member, owner, send }
  return null
}

function StructuredChatProbe({
  scope,
  skillsOpen,
  mentionQuery
}: {
  scope: NativeChatTabScope
  skillsOpen: boolean
  mentionQuery: string | null
}): null {
  useNativeChatFileLinkContext(scope)
  useNativeChatImageRuntimeContext(scope)
  useNativeChatSkills('codex', scope, skillsOpen)
  useNativeChatMentionFiles({ query: mentionQuery, scope })
  // Structured chat keeps its own option surface; this hook must not resolve terminal discovery.
  useNativeChatSessionOptions({
    agent: 'codex',
    scope,
    targetPtyId: null,
    dispatchCommand: vi.fn()
  })
  return null
}

function runBridgeActions(scope: NativeChatBridgeTabScope): void {
  const state = useAppStore.getState()
  act(() => {
    bridgeApi!.send.sendRaw('1')
    void bridgeApi!.send.sendRawVerified('1')
    bridgeApi!.send.sendAnswer(
      { questions: [{ question: 'q', multiSelect: false, options: [{ label: 'A' }] }] },
      [{ indices: [0] }]
    )
    void bridgeApi!.send.cancelAsk()
    bridgeApi!.send.cancel()
  })
  resolveNativeChatBridgeRuntimeSettings(state, scope)
  resolveNativeChatAttachmentOwner(state, scope)
  resolveNativeChatModelDiscoveryContext(scope)
}

beforeEach(() => {
  resetCounters()
  bridgeApi = null
  listRuntimeFilesMock.mockReset().mockResolvedValue({ files: [], truncated: false })
  searchRuntimeFilePathsMock.mockReset().mockResolvedValue({ files: [], truncated: false })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialAppState, true)
})

describe('native chat workspace lookups', () => {
  it('old-scan control: the counter catches the global tab search chat used to run', () => {
    seed(100, 'bridge')
    getSettingsForAgentTabRuntimeOwner(CHAT_TAB)
    expect(counters.terminal.enumerations).toBeGreaterThan(0)
    expect(counters.terminal.foreignReads).toBeGreaterThan(0)
  })

  it.each([
    [120, 'closed pickers', false, null],
    [1200, 'closed pickers', false, null],
    [120, 'open pickers', true, 'src'],
    [1200, 'open pickers', true, 'src']
  ] as const)(
    'a bridge chat with %i unrelated workspaces and %s reads only its own bucket',
    (unrelated, _label, skillsOpen, mentionQuery) => {
      const scope: NativeChatBridgeTabScope = { kind: 'bridge', worktreeId: OWN, tabId: CHAT_TAB }
      const initial = seed(unrelated, 'bridge')
      render(<BridgeChatProbe scope={scope} skillsOpen={skillsOpen} mentionQuery={mentionQuery} />)
      replayUnrelatedPublications(initial, 'bridge')
      runBridgeActions(scope)

      expect(bridgeApi?.member).toBe(true)
      expect(bridgeApi?.owner).toBe('env-1')
      expect(counters.terminal).toMatchObject({ foreignReads: 0, enumerations: 0 })
      expect(counters.unified).toMatchObject({ foreignReads: 0, enumerations: 0 })
      expect(counters.terminal.anyReads).toBeGreaterThan(0)
    }
  )

  it.each([120, 1200])(
    'a structured chat with %i unrelated workspaces never reads terminal inventory',
    (unrelated) => {
      const scope: NativeChatTabScope = { kind: 'structured', worktreeId: OWN, tabId: CHAT_TAB }
      const initial = seed(unrelated, 'structured')
      const view = render(
        <StructuredChatProbe scope={scope} skillsOpen={false} mentionQuery={null} />
      )
      view.rerender(<StructuredChatProbe scope={scope} skillsOpen mentionQuery="src" />)
      replayUnrelatedPublications(initial, 'structured')
      resolveNativeChatAttachmentOwner(useAppStore.getState(), scope)

      // Every unrelated workspace holds a terminal row with the chat's id; none is consulted.
      expect(counters.terminal.anyReads).toBe(0)
      expect(counters.terminal.enumerations).toBe(0)
      expect(counters.unified).toMatchObject({ foreignReads: 0, enumerations: 0 })
    }
  )
})
