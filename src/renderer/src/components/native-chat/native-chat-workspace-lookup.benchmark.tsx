// @vitest-environment happy-dom

// STA-9590 before/after workload: mounted native chats under many workspaces, measured while
// unrelated status and title publications land and while users act. Build-specific hook calls
// live in ./native-chat-workspace-lookup-benchmark-probe; everything here is shared.
// Run: pnpm bench:native-chat-lookups (ORCA_NATIVE_CHAT_LOOKUP_BENCH_OUT=<path> writes the artifact).

import { act, cleanup, render } from '@testing-library/react'
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { Profiler } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import type * as SessionOptionDiscoveryModule from './native-chat-session-option-discovery'

vi.mock('@/runtime/runtime-file-client', () => ({
  listRuntimeFiles: async () => [],
  cancelRuntimeFileList: () => {},
  searchRuntimeFilePaths: async () => ({ files: [], truncated: false })
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  callRuntimeRpc: async () => ({ skills: [], sources: [] })
}))
vi.mock('./native-chat-session-option-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionOptionDiscoveryModule>()),
  discoverNativeChatCatalogModels: async () => null
}))

import { useAppStore } from '@/store'
import {
  runChatActions,
  useBridgeChatLookups,
  useStructuredChatLookups,
  type BenchmarkChat,
  type BenchmarkPickers
} from './native-chat-workspace-lookup-benchmark-probe'
import {
  agentSessionTabFixture,
  repoFixture,
  terminalTabFixture,
  worktreeFixture
} from './native-chat-workspace-test-fixtures'

const ENABLED = process.env.ORCA_NATIVE_CHAT_LOOKUP_BENCH === '1'

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const ROUNDS = positiveInt('ORCA_NATIVE_CHAT_LOOKUP_BENCH_ROUNDS', 5)
const STATUS_PUBLICATIONS = positiveInt('ORCA_NATIVE_CHAT_LOOKUP_BENCH_STATUS', 200)
const RETITLE_PUBLICATIONS = positiveInt('ORCA_NATIVE_CHAT_LOOKUP_BENCH_RETITLES', 50)
const ACTION_ROUNDS = positiveInt('ORCA_NATIVE_CHAT_LOOKUP_BENCH_ACTIONS', 50)
const BRIDGE_CHATS = 10
const STRUCTURED_CHATS = 10

const SCALES = [
  { name: 'w100', workspaces: 100, terminalRows: 240 },
  { name: 'w1200', workspaces: 1200, terminalRows: 2600 }
] as const
const PICKERS: Record<string, BenchmarkPickers> = {
  pickersClosed: { skillsOpen: false, mentionQuery: null },
  pickersOpen: { skillsOpen: true, mentionQuery: 'src' }
}
const HOSTS = [
  { repoId: 'repo-local', hostId: 'local' },
  { repoId: 'repo-ssh', hostId: 'ssh:conn-1' },
  { repoId: 'repo-runtime', hostId: 'runtime:env-1' }
] as const

type Maps = {
  tabsByWorktree: Record<string, TerminalTab[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
}

type Fixture = Maps & {
  chats: BenchmarkChat[]
  unrelatedWorkspaceIds: string[]
  worktreesByRepo: Record<string, Worktree[]>
}

/** Chats sit evenly through insertion order, so a front-to-back search does average work. */
function buildFixture(workspaces: number, terminalRows: number): Fixture {
  const maps: Maps = { tabsByWorktree: {}, unifiedTabsByWorktree: {} }
  const worktreesByRepo: Record<string, Worktree[]> = {}
  const chatStride = Math.floor(workspaces / (BRIDGE_CHATS + STRUCTURED_CHATS))
  const chats: BenchmarkChat[] = []
  const unrelatedWorkspaceIds: string[] = []
  for (let index = 0; index < workspaces; index += 1) {
    const host = HOSTS[index % HOSTS.length]!
    const worktreeId = `${host.repoId}::/work/w${index}`
    ;(worktreesByRepo[host.repoId] ??= []).push(
      worktreeFixture(worktreeId, `/work/w${index}`, { repoId: host.repoId, hostId: host.hostId })
    )
    const rows = Math.floor(terminalRows / workspaces) + (index < terminalRows % workspaces ? 1 : 0)
    const terminals = Array.from({ length: rows }, (_, row) =>
      terminalTabFixture(`t-${index}-${row}`, worktreeId)
    )
    const unified = terminals.map((tab) =>
      agentSessionTabFixture(`u-${tab.id}`, worktreeId, {
        contentType: 'terminal',
        entityId: tab.id
      })
    )
    const chatIndex = index % chatStride === 0 ? index / chatStride : -1
    if (chatIndex >= 0 && chatIndex < BRIDGE_CHATS) {
      const tabId = `chat-${index}`
      terminals.push(terminalTabFixture(tabId, worktreeId))
      unified.push(
        agentSessionTabFixture(`u-${tabId}`, worktreeId, {
          contentType: 'terminal',
          entityId: tabId
        })
      )
      chats.push({
        mode: 'bridge',
        worktreeId,
        tabId,
        paneKey: `${tabId}:leaf`,
        ptyId: `pty-${index}`
      })
    } else if (chatIndex >= BRIDGE_CHATS && chatIndex < BRIDGE_CHATS + STRUCTURED_CHATS) {
      const tabId = `chat-${index}`
      unified.push(agentSessionTabFixture(tabId, worktreeId))
      chats.push({
        mode: 'structured',
        worktreeId,
        tabId,
        paneKey: `${tabId}:session`,
        ptyId: null
      })
    } else {
      unrelatedWorkspaceIds.push(worktreeId)
    }
    maps.tabsByWorktree[worktreeId] = terminals
    maps.unifiedTabsByWorktree[worktreeId] = unified
  }
  return { ...maps, chats, unrelatedWorkspaceIds, worktreesByRepo }
}

type Counter = { foreignReads: number; enumerations: number }
type Counting = { counter: Counter; own: ReadonlySet<string> } | null

function counted<T>(map: Record<string, T>, counting: Counting): Record<string, T> {
  if (!counting) {
    return map
  }
  return new Proxy(map, {
    get(target, key, receiver) {
      if (typeof key === 'string' && Object.hasOwn(target, key) && !counting.own.has(key)) {
        counting.counter.foreignReads += 1
      }
      return Reflect.get(target, key, receiver)
    },
    ownKeys(target) {
      counting.counter.enumerations += 1
      return Reflect.ownKeys(target)
    }
  })
}

function publishMaps(maps: Maps, counting: Counting): void {
  useAppStore.setState({
    tabsByWorktree: counted(maps.tabsByWorktree, counting),
    unifiedTabsByWorktree: counted(maps.unifiedTabsByWorktree, counting)
  })
}

function seedStore(fixture: Fixture, counting: Counting): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/bench'), activeRuntimeEnvironmentId: null },
    repos: [
      repoFixture({ id: 'repo-local', connectionId: null }),
      repoFixture({ id: 'repo-ssh', connectionId: 'conn-1' }),
      repoFixture({ id: 'repo-runtime', executionHostId: 'runtime:env-1' })
    ],
    worktreesByRepo: fixture.worktreesByRepo
  })
  publishMaps(fixture, counting)
}

function ChatProbe({
  chat,
  pickers
}: {
  chat: BenchmarkChat
  pickers: BenchmarkPickers
}): React.JSX.Element {
  return chat.mode === 'bridge' ? (
    <BridgeChat chat={chat} pickers={pickers} />
  ) : (
    <StructuredChat chat={chat} pickers={pickers} />
  )
}
function BridgeChat({ chat, pickers }: { chat: BenchmarkChat; pickers: BenchmarkPickers }): null {
  useBridgeChatLookups(chat, pickers)
  return null
}
function StructuredChat({
  chat,
  pickers
}: {
  chat: BenchmarkChat
  pickers: BenchmarkPickers
}): null {
  useStructuredChatLookups(chat, pickers)
  return null
}

type Measured = { listenerMs: number[]; totalMs: number[]; commits: number }

/** Times the store's synchronous selector pass separately from the React work it schedules. */
function measurePublication(measured: Measured, publish: () => void): void {
  const start = performance.now()
  let listenerEnd = start
  act(() => {
    publish()
    listenerEnd = performance.now()
  })
  measured.listenerMs.push(listenerEnd - start)
  measured.totalMs.push(performance.now() - start)
}

function statusEntry(paneKey: string, sequence: number): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'unrelated work',
    updatedAt: sequence,
    stateStartedAt: sequence,
    agentType: 'claude',
    paneKey,
    stateHistory: []
  }
}

type ScenarioResult = {
  mountMs: number
  status: Measured
  retitle: Measured
  actionRoundMs: number
  counts: { status: Counter; retitle: Counter; actions: Counter }
}

function runScenario(
  fixture: Fixture,
  pickers: BenchmarkPickers,
  counter: Counter | null
): ScenarioResult {
  const own = new Set(fixture.chats.map((chat) => chat.worktreeId))
  const counting: Counting = counter ? { counter, own } : null
  const commits = { value: 0 }
  seedStore(fixture, counting)
  const mountStart = performance.now()
  act(() => {
    render(
      <Profiler id="chats" onRender={() => (commits.value += 1)}>
        {fixture.chats.map((chat) => (
          <ChatProbe key={chat.tabId} chat={chat} pickers={pickers} />
        ))}
      </Profiler>
    )
  })
  const mountMs = performance.now() - mountStart
  const snapshot = (): Counter => ({ ...(counter ?? { foreignReads: 0, enumerations: 0 }) })
  const delta = (before: Counter): Counter => ({
    foreignReads: (counter?.foreignReads ?? 0) - before.foreignReads,
    enumerations: (counter?.enumerations ?? 0) - before.enumerations
  })

  const statusBefore = snapshot()
  const status: Measured = { listenerMs: [], totalMs: [], commits: 0 }
  commits.value = 0
  let statusByPane: Record<string, AgentStatusEntry> = {}
  for (let index = 0; index < STATUS_PUBLICATIONS; index += 1) {
    const paneKey = `unrelated-${index % 40}:leaf`
    // Built before timing: the producer's own work is not what is measured.
    statusByPane = { ...statusByPane, [paneKey]: statusEntry(paneKey, index) }
    const next = statusByPane
    measurePublication(status, () => useAppStore.setState({ agentStatusByPaneKey: next }))
  }
  status.commits = commits.value
  const statusCounts = delta(statusBefore)

  const retitleBefore = snapshot()
  const retitle: Measured = { listenerMs: [], totalMs: [], commits: 0 }
  commits.value = 0
  let maps: Maps = {
    tabsByWorktree: fixture.tabsByWorktree,
    unifiedTabsByWorktree: fixture.unifiedTabsByWorktree
  }
  for (let index = 0; index < RETITLE_PUBLICATIONS; index += 1) {
    const worktreeId = fixture.unrelatedWorkspaceIds[index % fixture.unrelatedWorkspaceIds.length]!
    maps = {
      tabsByWorktree: {
        ...maps.tabsByWorktree,
        [worktreeId]: maps.tabsByWorktree[worktreeId]!.map((tab, row) =>
          row === 0 ? { ...tab, title: `Renamed ${index}` } : tab
        )
      },
      unifiedTabsByWorktree: { ...maps.unifiedTabsByWorktree }
    }
    const next = maps
    measurePublication(retitle, () => publishMaps(next, counting))
  }
  retitle.commits = commits.value
  const retitleCounts = delta(retitleBefore)

  const actionsBefore = snapshot()
  const actionStart = performance.now()
  const actionRounds = counter ? 1 : ACTION_ROUNDS
  for (let round = 0; round < actionRounds; round += 1) {
    for (const chat of fixture.chats) {
      runChatActions(chat)
    }
  }
  const actionRoundMs = (performance.now() - actionStart) / actionRounds
  const actionCounts = delta(actionsBefore)
  cleanup()
  return {
    mountMs,
    status,
    retitle,
    actionRoundMs,
    counts: { status: statusCounts, retitle: retitleCounts, actions: actionCounts }
  }
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)
const mean = (values: number[]): number => sum(values) / Math.max(values.length, 1)
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const round3 = (value: number): number => Math.round(value * 1000) / 1000

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe.runIf(ENABLED)('native chat workspace lookup benchmark', () => {
  it('measures mounted chats under unrelated publications and user actions', () => {
    const summary: Record<string, Record<string, Record<string, number>>> = {}
    const variability: Record<string, Record<string, Record<string, number[]>>> = {}
    for (const scale of SCALES) {
      const fixture = buildFixture(scale.workspaces, scale.terminalRows)
      expect(fixture.chats).toHaveLength(BRIDGE_CHATS + STRUCTURED_CHATS)
      for (const [pickerName, pickers] of Object.entries(PICKERS)) {
        // Warm-up: module init and first-render caches are not part of the comparison.
        runScenario(fixture, pickers, null)
        const rounds: ScenarioResult[] = []
        for (let round = 0; round < ROUNDS; round += 1) {
          const gc: unknown = Reflect.get(globalThis, 'gc')
          if (typeof gc === 'function') {
            gc()
          }
          rounds.push(runScenario(fixture, pickers, null))
        }
        const counts = runScenario(fixture, pickers, { foreignReads: 0, enumerations: 0 }).counts
        const perRound = {
          statusListenerMsPerPublication: rounds.map((r) => mean(r.status.listenerMs)),
          statusTotalMsPerPublication: rounds.map((r) => mean(r.status.totalMs)),
          retitleListenerMsPerPublication: rounds.map((r) => mean(r.retitle.listenerMs)),
          retitleTotalMsPerPublication: rounds.map((r) => mean(r.retitle.totalMs)),
          actionRoundMsAllChats: rounds.map((r) => r.actionRoundMs),
          mountMsAllChats: rounds.map((r) => r.mountMs)
        }
        ;(summary[scale.name] ??= {})[pickerName] = {
          ...Object.fromEntries(
            Object.entries(perRound).map(([key, values]) => [key, round3(median(values))])
          ),
          statusCommitsPerPublication: round3(
            median(rounds.map((r) => r.status.commits)) / STATUS_PUBLICATIONS
          ),
          retitleCommitsPerPublication: round3(
            median(rounds.map((r) => r.retitle.commits)) / RETITLE_PUBLICATIONS
          ),
          statusForeignBucketReadsPerPublication: round3(
            counts.status.foreignReads / STATUS_PUBLICATIONS
          ),
          statusMapEnumerationsPerPublication: round3(
            counts.status.enumerations / STATUS_PUBLICATIONS
          ),
          retitleForeignBucketReadsPerPublication: round3(
            counts.retitle.foreignReads / RETITLE_PUBLICATIONS
          ),
          retitleMapEnumerationsPerPublication: round3(
            counts.retitle.enumerations / RETITLE_PUBLICATIONS
          ),
          actionForeignBucketReadsPerRound: counts.actions.foreignReads,
          actionMapEnumerationsPerRound: counts.actions.enumerations
        }
        ;(variability[scale.name] ??= {})[pickerName] = Object.fromEntries(
          Object.entries(perRound).map(([key, values]) => [key, values.map(round3)])
        )
      }
    }
    const artifact = {
      label: process.env.ORCA_NATIVE_CHAT_LOOKUP_BENCH_LABEL ?? 'dev',
      config: {
        rounds: ROUNDS,
        statusPublications: STATUS_PUBLICATIONS,
        retitlePublications: RETITLE_PUBLICATIONS,
        actionRounds: ACTION_ROUNDS,
        mountedChats: { bridge: BRIDGE_CHATS, structured: STRUCTURED_CHATS },
        scales: SCALES,
        runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`
      },
      summary,
      variability
    }
    const out = process.env.ORCA_NATIVE_CHAT_LOOKUP_BENCH_OUT
    if (out) {
      writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`)
    }
    console.log(JSON.stringify(summary, null, 2))
  }, 600_000)
})
