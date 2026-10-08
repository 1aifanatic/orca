import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '../../src/renderer/src/lib/agent-status'
import { RuntimeRpcCallError } from '../../src/renderer/src/runtime/runtime-rpc-result'
import { mapRuntimeError } from '../../src/main/runtime/rpc/errors'
import { createTabsSliceMockApi } from '../../src/renderer/src/store/slices/tabs-slice-test-harness'
import { createTestStore } from '../../src/renderer/src/store/slices/store-test-helpers'
import {
  agentSessionOperationKey,
  pendingAgentSessionOperationRow
} from '../../src/shared/agent-session-operation-ledger'
import {
  AGENT_LAUNCH_DESKTOP_NEW_TAB_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY
} from '../../src/shared/agent-launch-runtime-capability'
import type { AgentLaunchResult } from '../../src/shared/agent-launch-intent'
import type { AgentLaunchPaneVerdict } from '../../src/shared/agent-launch-pane-verdict'
import {
  markAgentLaunchesClosedByUser,
  resetAgentLaunchPanesForTests,
  resolveAgentLaunchPaneVerdict
} from '../../src/main/agent-launch/agent-launch-pane-attachment'
import { openTestAgentSessionRecordStore } from '../../src/main/runtime/agent-session-record-store-test-harness'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore
} from '../../src/main/runtime/rpc/methods/agent-launch.test-fixture'
import { DESKTOP_RPC_CALLER } from '../../src/main/runtime/rpc/rpc-caller-identity'
import { activeAgentLaunchesFor } from '../../src/main/runtime/rpc/methods/agent-launch-active-operations'
import { makePaneKey } from '../../src/shared/stable-pane-id'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../src/renderer/src/lib/agent-status', async (original) => ({
  ...(await original<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))
const storeRef = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('../../src/renderer/src/store', () => ({
  useAppStore: { getState: () => storeRef.current!.getState() }
}))
const deliver = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../../src/main/runtime/rpc/methods/agent-launch-terminal-prompt', () => ({
  deliverTerminalAgentLaunchPrompt: deliver
}))
const callRuntimeRpc = vi.hoisted(() =>
  vi.fn<(target: unknown, method: string, params: Record<string, unknown>) => Promise<unknown>>()
)
vi.mock('../../src/renderer/src/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<object>()),
  callRuntimeRpc
}))
createTabsSliceMockApi()
const { AGENT_LAUNCH_METHODS } = await import('../../src/main/runtime/rpc/methods/agent-launch')
const LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
const { launchAgentThroughHost } =
  await import('../../src/renderer/src/lib/agent-launch-through-host')
const { publishAgentLaunchTab } =
  await import('../../src/renderer/src/lib/agent-launch-tab-publication')
const { applyAgentLaunchPaneVerdict } =
  await import('../../src/renderer/src/lib/agent-launch-pane-verdict-application')

const WT = 'wt-7'
const OTHER = 'wt-other'
const PROMPT = {
  text: "first '🦄'\nsecond\x1b",
  delivery: 'submit',
  transport: { kind: 'desktop-new-tab', promptDelivery: 'submit-after-ready' }
} as const

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let store: ReturnType<typeof createTestStore>
let record: Awaited<ReturnType<typeof openTestAgentSessionRecordStore>>

beforeEach(async () => {
  store = createTestStore()
  storeRef.current = store
  store.getState().setActiveWorktree(WT)
  store.getState().createTab(WT)
  callRuntimeRpc.mockReset()
  deliver.mockClear()
  const directory = await mkdtemp(
    join(process.env.ORCA_STEP4_TEST_STATE_DIR ?? tmpdir(), 'b-capacity-')
  )
  record = await openTestAgentSessionRecordStore(directory)
  const now = Date.now()
  await record.transactOperations((draft) => {
    for (let index = 0; index < 512; index += 1) {
      const operationId = `${now}-${index.toString(16).padStart(32, '0')}`
      const callerKey = 'trusted-local:desktop'
      draft.operations.set(
        agentSessionOperationKey(callerKey, operationId),
        pendingAgentSessionOperationRow({ callerKey, operationId, fingerprint: 'seeded', now })
      )
    }
  })
  setAgentLaunchRecordStore(record)
})

afterEach(() => {
  resetAgentLaunchPanesForTests()
  setAgentLaunchRecordStore(null)
})

function rig(
  options: {
    selectOther?: boolean
    failure?: 'before' | 'after'
    admissionError?: string
  } = {}
) {
  const start = deferred<void>()
  const admitted = deferred<void>()
  const admission = deferred<void>()
  const mount: {
    verdict: AgentLaunchPaneVerdict | null
    shellStarts: number
    attachments: number
  } = {
    verdict: null,
    shellStarts: 0,
    attachments: 0
  }
  const requests: Record<string, unknown>[] = []
  const verdicts: AgentLaunchPaneVerdict[] = []
  const runtime = runtimeStub({
    settings: {},
    publishAgentLaunchTab: async (request) => {
      const answer = publishAgentLaunchTab({ ...request, requestId: 'capacity-publication' })
      const waiting = resolveAgentLaunchPaneVerdict(
        { worktreeId: request.worktreeId, paneKey: `${request.tabId}:${request.leafId}` },
        {
          isPaneLive: (key) => runtime.hasLiveTerminalForPaneKey(key),
          openedRows: () => record.listOperationRows(),
          launchPaneOnTab: () =>
            store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === request.tabId)
              ?.agentLaunchPane ?? null,
          openRows: async () => record.listOperationRows(),
          now: () => Date.now()
        }
      )
      if (!waiting) {
        throw new Error('unowned pane at mount')
      }
      void waiting.then((verdict) => {
        mount.verdict = verdict
        applyAgentLaunchPaneVerdict({ ...request, verdict })
        if (verdict.kind === 'proceed') {
          if (runtime.hasLiveTerminalForPaneKey(`${request.tabId}:${request.leafId}`)) {
            mount.attachments += 1
          } else {
            mount.shellStarts += 1
          }
        }
      })
      return answer
    }
  })
  const context = rpcContext(runtime, {
    caller: DESKTOP_RPC_CALLER,
    clientKind: 'runtime',
    clientCapabilities: [
      AGENT_LAUNCH_RUNTIME_CAPABILITY,
      AGENT_LAUNCH_DESKTOP_NEW_TAB_RUNTIME_CAPABILITY,
      AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY
    ]
  })
  const open = runtime.openAgentSessionRecordStore.getMockImplementation()!
  runtime.openAgentSessionRecordStore.mockImplementation(async () => {
    admitted.resolve()
    await admission.promise
    if (options.admissionError) {
      throw new Error(options.admissionError)
    }
    return open()
  })
  let livePane: string | null = null
  runtime.hasLiveTerminalForPaneKey.mockImplementation((key) => livePane === key)
  runtime.getTerminalHandleForPaneKey.mockImplementation((key) =>
    livePane === key ? 'term_1' : null
  )
  runtime.createTerminal.mockImplementation(async (_selector, createOptions) => {
    await start.promise
    if (options.failure === 'after' && typeof createOptions?.onPtySpawnDispatched === 'function') {
      createOptions.onPtySpawnDispatched()
    }
    if (options.failure) {
      throw new Error('spawn_failed')
    }
    if (typeof createOptions?.onPtySpawnDispatched === 'function') {
      createOptions.onPtySpawnDispatched()
    }
    const tabId = createOptions?.tabId
    const leafId = createOptions?.leafId
    if (typeof tabId !== 'string' || typeof leafId !== 'string') {
      throw new Error('missing reserved pane')
    }
    livePane = makePaneKey(tabId, leafId)
    return { handle: 'term_1', paneKey: livePane }
  })
  runtime.closeTerminal.mockImplementation(async () => {
    livePane = null
    return {}
  })
  runtime.reportAgentLaunchPaneVerdict.mockImplementation((pane, verdict) => {
    applyAgentLaunchPaneVerdict({ ...pane, verdict })
    verdicts.push(verdict)
  })
  callRuntimeRpc.mockImplementation(async (_target, method, params) => {
    requests.push(params)
    if (method !== 'agent.launch') {
      throw new Error(`unexpected desktop method ${method}`)
    }
    try {
      return await LAUNCH.handler(LAUNCH.params.parse(params), context)
    } catch (error) {
      throw new RuntimeRpcCallError(
        mapRuntimeError('desktop-capacity', { runtimeId: 'capacity-runtime' }, error)
      )
    }
  })
  if (options.selectOther) {
    store.getState().createTab(OTHER)
    store.getState().setActiveWorktree(OTHER)
  }
  const selected = store.getState().activeTabId
  const groupId = store.getState().groupsByWorktree[WT]![0]!.id
  const launch = () =>
    launchAgentThroughHost({
      agent: 'claude',
      worktreeId: WT,
      groupId,
      prompt: PROMPT.text,
      desktopPrompt: PROMPT,
      activate: false,
      agentArgs: null,
      cwd: '/tmp/wt-7/src',
      sessionOptions: { model: 'chosen', thinking: true }
    })
  return {
    runtime,
    context,
    mount,
    verdicts,
    requests,
    selected,
    groupId,
    launch,
    start,
    admitted,
    admission
  }
}

function tab(tabId: string) {
  return store.getState().tabsByWorktree[WT]?.find((candidate) => candidate.id === tabId)
}

describe('desktop capacity fallback keeps the original published pane', () => {
  it('never falls back when admission loses its answer, even with capacity in the error text', async () => {
    const r = rig({ admissionError: 'agent_session_operation_capacity' })
    const { tabId, outcome } = r.launch()
    await r.admitted.promise
    r.admission.resolve()
    await outcome
    await vi.waitFor(() => expect(r.mount.verdict).toEqual({ kind: 'withdrawn' }))
    expect(tab(tabId)).toBeUndefined()
    expect(r.runtime.createTerminal).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenCalledOnce()
    expect(r.mount.shellStarts).toBe(0)
    expect(activeAgentLaunchesFor(r.context.runtime).size).toBe(0)
  })

  it.each([false, true])(
    'binds once without a shell or selection drift (other workspace %s)',
    async (selectOther) => {
      const r = rig({ selectOther })
      const { tabId, outcome } = r.launch()
      await r.admitted.promise
      expect(tab(tabId)).toBeDefined()
      expect(r.mount.verdict).toBeNull()
      expect(deliver).not.toHaveBeenCalled()
      r.admission.resolve()
      await vi.waitFor(() => expect(r.runtime.createTerminal).toHaveBeenCalledOnce())
      expect(tab(tabId)).toBeDefined()
      expect(r.mount.verdict).toBeNull()
      expect(r.mount.shellStarts).toBe(0)
      r.start.resolve()
      await expect(outcome).resolves.toMatchObject({ kind: 'started', unrecorded: true })
      await vi.waitFor(() => expect(r.mount.attachments).toBe(1))
      expect(r.mount.shellStarts).toBe(0)
      expect(r.verdicts).not.toContainEqual({ kind: 'withdrawn' })
      expect(callRuntimeRpc).toHaveBeenCalledOnce()
      expect(r.runtime.createTerminal).toHaveBeenCalledOnce()
      expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: PROMPT }))
      expect(r.runtime.createTerminal.mock.calls[0]?.[1]).toMatchObject({
        tabId,
        leafId: r.requests[0]?.paneKey?.toString().split(':')[1],
        agentArgs: null,
        cwd: '/tmp/wt-7/src',
        desktopPrompt: PROMPT,
        presentation: 'background',
        surfaceOwner: false,
        desktopSessionOptions: { model: 'chosen', thinking: true }
      })
      expect(store.getState().activeTabId).toBe(r.selected)
      expect(
        store.getState().unifiedTabsByWorktree[WT]?.find((item) => item.entityId === tabId)?.groupId
      ).toBe(r.groupId)
      expect(activeAgentLaunchesFor(r.context.runtime).size).toBe(0)
      expect(record.listOperationRows()).toHaveLength(512)
    }
  )

  it.each(['before', 'after'] as const)(
    'ends a %s-dispatch failure without an ordinary shell',
    async (failure) => {
      const r = rig({ failure })
      const { tabId, outcome } = r.launch()
      await r.admitted.promise
      r.admission.resolve()
      await vi.waitFor(() => expect(r.runtime.createTerminal).toHaveBeenCalledOnce())
      r.start.resolve()
      await outcome
      await vi.waitFor(() => expect(r.mount.verdict).not.toBeNull())
      expect(r.mount.verdict).toEqual(
        failure === 'before'
          ? { kind: 'not-started', code: 'spawn_failed' }
          : { kind: 'unconfirmed' }
      )
      expect(tab(tabId)?.agentLaunchPane?.outcome).toEqual(r.mount.verdict)
      expect(r.mount.shellStarts).toBe(0)
      expect(r.mount.attachments).toBe(0)
      expect(deliver).not.toHaveBeenCalled()
      expect(callRuntimeRpc).toHaveBeenCalledOnce()
      expect(activeAgentLaunchesFor(r.context.runtime).size).toBe(0)
    }
  )

  it('closing the published tab before capacity is decided prevents every effect', async () => {
    const r = rig()
    const { tabId, outcome } = r.launch()
    await r.admitted.promise
    markAgentLaunchesClosedByUser(WT, { kind: 'tab', tabId })
    store.getState().closeTab(tabId)
    r.admission.resolve()
    await expect(outcome).resolves.toEqual({ kind: 'closed-by-user' })
    await vi.waitFor(() => expect(r.mount.verdict).toEqual({ kind: 'withdrawn' }))
    expect(r.runtime.createTerminal).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    expect(r.mount.shellStarts).toBe(0)
    expect(tab(tabId)).toBeUndefined()
    expect(activeAgentLaunchesFor(r.context.runtime).size).toBe(0)
  })

  it('closing during a dispatched spawn stops its original agent before prompt input', async () => {
    const r = rig()
    const { tabId, outcome } = r.launch()
    await r.admitted.promise
    r.admission.resolve()
    await vi.waitFor(() => expect(r.runtime.createTerminal).toHaveBeenCalledOnce())
    markAgentLaunchesClosedByUser(WT, { kind: 'tab', tabId })
    store.getState().closeTab(tabId)
    r.start.resolve()
    await expect(outcome).resolves.toEqual({ kind: 'closed-by-user' })
    expect(r.runtime.closeTerminal).toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    expect(r.mount.shellStarts).toBe(0)
    expect(tab(tabId)).toBeUndefined()
    expect(activeAgentLaunchesFor(r.context.runtime).size).toBe(0)
  })

  it.each(['optional', 'replay'] as const)(
    'coalesces optional callers while strict Replay refuses (%s first)',
    async (first) => {
      const r = rig()
      let launched: ReturnType<typeof r.launch> | undefined
      let replay: Promise<AgentLaunchResult>
      if (first === 'optional') {
        launched = r.launch()
        await r.admitted.promise
        replay = REPLAY.handler(REPLAY.params.parse(r.requests[0]), r.context)
      } else {
        const tabId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
        const leafId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
        const params = {
          agent: 'claude',
          target: { kind: 'existing', worktree: `id:${WT}` },
          operationId: `${Date.now()}-ffffffffffffffffffffffffffffffff`,
          paneKey: `${tabId}:${leafId}`,
          prompt: PROMPT,
          presentation: 'background',
          agentArgs: null
        }
        replay = REPLAY.handler(REPLAY.params.parse(params), r.context)
        r.requests.push(params)
        await r.admitted.promise
      }
      const strict = expect(replay).rejects.toThrow('agent_session_operation_capacity')
      const duplicate = LAUNCH.handler(LAUNCH.params.parse(r.requests[0]), r.context)
      const another = LAUNCH.handler(LAUNCH.params.parse(r.requests[0]), r.context)
      void duplicate.catch(() => {})
      void another.catch(() => {})
      r.admission.resolve()
      await strict
      await vi.waitFor(() => expect(r.runtime.createTerminal).toHaveBeenCalledOnce())
      const live = activeAgentLaunchesFor(r.context.runtime)
      expect(live.size).toBe(1)
      r.start.resolve()
      await expect(duplicate).resolves.toMatchObject({
        recorded: false,
        outcome: { kind: 'terminal' }
      })
      expect(await another).toEqual(await duplicate)
      if (launched) {
        await expect(launched.outcome).resolves.toMatchObject({ unrecorded: true })
      }
      expect(r.runtime.createTerminal).toHaveBeenCalledOnce()
      expect(live.size).toBe(0)
      expect(r.mount.shellStarts).toBe(0)
    }
  )

  it('a strict Replay alone still refuses capacity and withdraws its unused tab', async () => {
    const r = rig()
    const tabId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
    const params = REPLAY.params.parse({
      agent: 'claude',
      target: { kind: 'existing', worktree: `id:${WT}` },
      operationId: `${Date.now()}-ffffffffffffffffffffffffffffffff`,
      paneKey: `${tabId}:3f2504e0-4f89-41d3-9a0c-0305e82c3301`,
      prompt: PROMPT,
      presentation: 'background'
    })
    const answer = expect(REPLAY.handler(params, r.context)).rejects.toThrow(
      'agent_session_operation_capacity'
    )
    await r.admitted.promise
    r.admission.resolve()
    await answer
    await vi.waitFor(() => expect(r.mount.verdict).toEqual({ kind: 'withdrawn' }))
    expect(tab(tabId)).toBeUndefined()
    expect(r.runtime.createTerminal).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    expect(activeAgentLaunchesFor(r.context.runtime).size).toBe(0)
  })

  it('an older optional request finishing cannot release a replacement active owner', async () => {
    const r = rig()
    const { outcome } = r.launch()
    await r.admitted.promise
    r.admission.resolve()
    await vi.waitFor(() => expect(r.runtime.createTerminal).toHaveBeenCalledOnce())
    const active = activeAgentLaunchesFor(r.context.runtime)
    const entry = active.entries().next().value
    if (!entry) {
      throw new Error('missing active request')
    }
    const [key, original] = entry
    const replacement = {
      fingerprint: original.fingerprint,
      promise: deferred<AgentLaunchResult>().promise
    }
    active.set(key, replacement)
    r.start.resolve()
    await outcome
    expect(active.get(key)).toBe(replacement)
    active.delete(key)
  })
})
