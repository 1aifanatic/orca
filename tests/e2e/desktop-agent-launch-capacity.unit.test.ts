import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { AgentSessionAttachResult } from '../../src/shared/agent-session-wire'
import type * as AgentStatusModule from '../../src/renderer/src/lib/agent-status'
import { createTabsSliceMockApi } from '../../src/renderer/src/store/slices/tabs-slice-test-harness'
import { createTestStore } from '../../src/renderer/src/store/slices/store-test-helpers'
import {
  agentSessionOperationKey,
  pendingAgentSessionOperationRow
} from '../../src/shared/agent-session-operation-ledger'
import type { AgentLaunchResult } from '../../src/shared/agent-launch-intent'
import {
  isAgentLaunchRunningIn,
  markAgentLaunchesClosedByUser,
  resetAgentLaunchPanesForTests
} from '../../src/main/agent-launch/agent-launch-pane-attachment'
import { openTestAgentSessionRecordStore } from '../../src/main/runtime/agent-session-record-store-test-harness'
import {
  methodNamed,
  setAgentLaunchRecordStore
} from '../../src/main/runtime/rpc/methods/agent-launch.test-fixture'
import { activeAgentLaunchesFor } from '../../src/main/runtime/rpc/methods/agent-launch-active-operations'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { installDesktopStructuredTestHost } from './desktop-agent-launch-structured-test-host'
import { createDesktopAgentLaunchRig, deferred } from './desktop-agent-launch-composed-test-rig'

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

const WT = 'wt-7'
const PROMPT = {
  text: "first '🦄'\nsecond\x1b",
  delivery: 'submit',
  transport: { kind: 'desktop-new-tab', promptDelivery: 'submit-after-ready' }
} as const

let store: ReturnType<typeof createTestStore>
let record: Awaited<ReturnType<typeof openTestAgentSessionRecordStore>>
let directory: string
let structured: ReturnType<typeof installDesktopStructuredTestHost> | undefined

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
  store = createTestStore()
  storeRef.current = store
  store.getState().setActiveWorktree(WT)
  store.getState().createTab(WT)
  callRuntimeRpc.mockReset()
  deliver.mockClear()
  vi.mocked(toast.error).mockClear()
  directory = await mkdtemp(join(process.env.ORCA_STEP4_TEST_STATE_DIR ?? tmpdir(), 'b-capacity-'))
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

afterEach(async () => {
  await structured?.host.flushAllStreamedEvents()
  structured = undefined
  setStructuredAgentSessionHost(null)
  resetAgentLaunchPanesForTests()
  setAgentLaunchRecordStore(null)
})

function rig(options: Parameters<typeof createDesktopAgentLaunchRig>[1] = {}) {
  return createDesktopAgentLaunchRig({ store, record, prompt: PROMPT, callRuntimeRpc }, options)
}

function tab(tabId: string) {
  return store.getState().tabsByWorktree[WT]?.find((candidate) => candidate.id === tabId)
}

describe('desktop capacity fallback keeps the original published pane', () => {
  it('a lost desktop creation reply without early publication retains its uncertainty notice after close', async () => {
    await record.transactOperations((draft) => draft.operations.clear())
    const r = rig({ failure: 'after', rootCwd: true, canPublish: false })
    r.admission.resolve()
    const { tabId, promptDeliveryResult } = r.launchPrompt()
    await r.creating.promise
    markAgentLaunchesClosedByUser(WT, { kind: 'tab', tabId })
    store.getState().closeTab(tabId)
    r.start.resolve()
    await expect(promptDeliveryResult).resolves.toMatchObject({ delivered: false })
    await expect(callRuntimeRpc.mock.results[0]?.value).rejects.toMatchObject({
      code: 'agent_session_operation_unknown'
    })
    const operationId = r.requests[0]?.operationId
    const row = record.listOperationRows().find((item) => item.operationId === operationId)
    expect(row?.outcome.status).not.toBe('failed')
    expect(r.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(r.runtime.createTerminal).toHaveBeenCalledOnce()
    expect(deliver).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledOnce()
    expect(tab(tabId)).toBeUndefined()
  })

  it.each([false, true])(
    'keeps the captured terminal and original input when the chat default changes (capacity=%s)',
    async (capacity) => {
      if (!capacity) {
        await record.transactOperations((draft) => draft.operations.clear())
      }
      const r = rig({ deferWorkspace: true, rootCwd: true })
      structured = installDesktopStructuredTestHost(r.runtime, record, directory)
      r.admission.resolve()
      const { tabId, outcome } = r.launch()
      await r.workspaceRequested.promise
      expect(isAgentLaunchRunningIn(WT, { kind: 'tab', tabId })).toBe(true)
      r.runtime.getClientSettings.mockReturnValue({
        experimentalNativeChat: true,
        experimentalStructuredNativeChat: true,
        openAgentTabsInChatByDefault: true
      })
      r.start.resolve()
      r.workspace.resolve()
      await expect(outcome).resolves.toMatchObject({ kind: 'started' })
      const result = await callRuntimeRpc.mock.results[0]?.value
      expect(result).toMatchObject({
        outcome: { kind: 'terminal', handle: 'term_1' },
        prompt: { outcome: 'handed-to-terminal' },
        ...(capacity ? { recorded: false } : {})
      })
      expect(r.runtime.createTerminal).toHaveBeenCalledExactlyOnceWith(
        `id:${WT}`,
        expect.objectContaining({
          tabId,
          desktopPrompt: PROMPT,
          agentArgs: null,
          cwd: '/tmp/wt-7',
          viewMode: 'terminal',
          desktopSessionOptions: { model: 'chosen', thinking: true }
        })
      )
      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: PROMPT.text, prompt: PROMPT })
      )
      expect(tab(tabId)?.viewMode ?? 'terminal').toBe('terminal')
      expect(r.runtime.publishAgentLaunchTab).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ tabId, viewMode: 'terminal' })
      )
      expect(structured.attach).not.toHaveBeenCalled()
      expect(structured.publish).not.toHaveBeenCalled()
      expect(structured.send).not.toHaveBeenCalled()
      expect(structured.acquire).not.toHaveBeenCalled()
      expect(record.getVisibleSessionTabIndex().sessionIds).toEqual([])
      expect(callRuntimeRpc).toHaveBeenCalledOnce()
      expect(r.mount.attachments).toBe(1)
      expect(r.mount.shellStarts).toBe(0)
    }
  )

  it.each([false, true])(
    'closed existing AI owner prevents structured effects after intent lookup (activate=%s)',
    async (activate) => {
      await record.transactOperations((draft) => draft.operations.clear())
      const r = rig({ deferWorkspace: true, rootCwd: true, structuredAi: true, activate })
      structured = installDesktopStructuredTestHost(r.runtime, record, directory)
      r.admission.resolve()
      const { tabId, promptDeliveryResult } = r.launchPrompt()
      await r.workspaceRequested.promise
      expect(isAgentLaunchRunningIn(WT, { kind: 'tab', tabId })).toBe(true)
      markAgentLaunchesClosedByUser(WT, { kind: 'tab', tabId })
      store.getState().closeTab(tabId)
      r.runtime.getClientSettings.mockReturnValue({
        experimentalNativeChat: true,
        experimentalStructuredNativeChat: true,
        openAgentTabsInChatByDefault: true
      })
      r.workspace.resolve()
      await expect(promptDeliveryResult).resolves.toMatchObject({ delivered: false })
      expect(structured.attach).not.toHaveBeenCalled()
      expect(structured.publish).not.toHaveBeenCalled()
      expect(structured.send).not.toHaveBeenCalled()
      expect(structured.acquire).not.toHaveBeenCalled()
      expect(r.runtime.createTerminal).not.toHaveBeenCalled()
      expect(deliver).not.toHaveBeenCalled()
      expect(callRuntimeRpc).toHaveBeenCalledOnce()
      expect(tab(tabId)).toBeUndefined()
      expect(isAgentLaunchRunningIn(WT, { kind: 'tab', tabId })).toBe(false)
    }
  )

  it.each(['attach', 'publication', 'send', 'lost-attach'] as const)(
    'settles a close during structured %s honestly without another launch',
    async (waitAt) => {
      await record.transactOperations((draft) => draft.operations.clear())
      const r = rig({ deferWorkspace: true, rootCwd: true, structuredAi: true })
      const s = installDesktopStructuredTestHost(r.runtime, record, directory)
      structured = s
      const created = deferred<AgentSessionAttachResult>()
      const entered = deferred<void>()
      const release = deferred<void>()
      const attach = s.attachOriginal
      s.attach.mockImplementationOnce(async (...args) => {
        const result = await attach(...args)
        if (!result.ok) {
          throw new Error('fixture attachment was refused')
        }
        created.resolve(result.value)
        if (waitAt === 'attach' || waitAt === 'lost-attach') {
          entered.resolve()
          await release.promise
          if (waitAt === 'lost-attach') {
            throw new Error('attach answer lost')
          }
        }
        return result
      })
      if (waitAt === 'publication') {
        const publish = s.publish.getMockImplementation()!
        s.publish.mockImplementationOnce(async (input) => {
          await publish(input)
          entered.resolve()
          await release.promise
        })
      } else if (waitAt === 'send') {
        const send = s.sendOriginal
        s.send.mockImplementationOnce(async (...args) => {
          const result = await send(...args)
          entered.resolve()
          await release.promise
          return result
        })
      }
      r.admission.resolve()
      const { tabId, promptDeliveryResult } = r.launchPrompt()
      await r.workspaceRequested.promise
      r.runtime.getClientSettings.mockReturnValue({
        experimentalNativeChat: true,
        experimentalStructuredNativeChat: true,
        openAgentTabsInChatByDefault: true
      })
      r.workspace.resolve()
      await Promise.race([
        entered.promise,
        promptDeliveryResult.then(async () => {
          throw new Error(
            `fixture did not reach ${waitAt}: ${JSON.stringify(await s.attach.mock.results[0]?.value)}`
          )
        })
      ])
      const session = await created.promise
      markAgentLaunchesClosedByUser(WT, { kind: 'tab', tabId })
      store.getState().closeTab(tabId)
      release.resolve()
      const request = callRuntimeRpc.mock.results[0]?.value
      if (!request) {
        throw new Error('missing launch request')
      }
      await expect(promptDeliveryResult).resolves.toMatchObject({ delivered: false })
      if (waitAt === 'lost-attach') {
        await expect(request).rejects.toMatchObject({ code: 'agent_session_operation_unknown' })
        expect(s.close).not.toHaveBeenCalled()
      } else {
        await expect(request).rejects.toMatchObject({ code: 'agent_launch_tab_closed' })
        expect(s.close).toHaveBeenCalledWith(session.sessionId, 'user-close')
        expect(s.retire).toHaveBeenCalledWith(session.sessionId)
        expect(s.visible.has(session.sessionId)).toBe(false)
        expect(record.getVisibleSessionTabIndex().sessionIds).not.toContain(session.sessionId)
      }
      const operationId = r.requests[0]?.operationId
      const row = record.listOperationRows().find((item) => item.operationId === operationId)
      expect(row?.outcome.status).not.toBe('failed')
      if (waitAt === 'send') {
        expect(row?.outcome).toMatchObject({
          status: 'succeeded',
          launch: { prompt: { outcome: 'journaled' } }
        })
        expect(await s.host.journalSnapshot(session.sessionId)).toMatchObject({
          items: expect.arrayContaining([
            expect.objectContaining({
              body: expect.objectContaining({ blocks: [{ type: 'text', text: PROMPT.text }] })
            })
          ])
        })
      } else {
        expect(s.send).not.toHaveBeenCalled()
      }
      if (waitAt === 'attach' || waitAt === 'lost-attach') {
        expect(s.publish).not.toHaveBeenCalled()
      }
      expect(s.attach).toHaveBeenCalledOnce()
      expect(r.runtime.createTerminal).not.toHaveBeenCalled()
      expect(deliver).not.toHaveBeenCalled()
      expect(callRuntimeRpc).toHaveBeenCalledOnce()
      expect(tab(tabId)).toBeUndefined()
      expect(toast.error).not.toHaveBeenCalled()
      expect(activeAgentLaunchesFor(r.context.runtime).size).toBe(0)
      expect(isAgentLaunchRunningIn(WT, { kind: 'tab', tabId })).toBe(false)
    }
  )

  it('an existing AI owner permits the current chat default and journals the exact original prompt once', async () => {
    await record.transactOperations((draft) => draft.operations.clear())
    const r = rig({ deferWorkspace: true, rootCwd: true, structuredAi: true })
    const s = installDesktopStructuredTestHost(r.runtime, record, directory)
    structured = s
    r.admission.resolve()
    const { outcome } = r.launch()
    await r.workspaceRequested.promise
    r.runtime.getClientSettings.mockReturnValue({
      experimentalNativeChat: true,
      experimentalStructuredNativeChat: true,
      openAgentTabsInChatByDefault: true
    })
    r.workspace.resolve()
    await expect(outcome).resolves.toEqual({ kind: 'pane-says' })
    await expect(callRuntimeRpc.mock.results[0]?.value).resolves.toMatchObject({
      outcome: { kind: 'structured' },
      prompt: { outcome: 'journaled' }
    })
    expect(s.attach).toHaveBeenCalledOnce()
    expect(s.publish).toHaveBeenCalledOnce()
    expect(s.send).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: PROMPT.text }] }
      })
    )
    expect(r.runtime.createTerminal).not.toHaveBeenCalled()
    expect(s.close).not.toHaveBeenCalled()
  })

  it.each([
    { activate: false, capacity: true },
    { activate: true, capacity: true },
    { activate: false, capacity: false },
    { activate: true, capacity: false }
  ])(
    'closed owner prevents effects when chat default changes during workspace lookup (%j)',
    async (options) => {
      if (!options.capacity) {
        await record.transactOperations((draft) => draft.operations.clear())
      }
      const r = rig({ ...options, deferWorkspace: true, rootCwd: true })
      structured = installDesktopStructuredTestHost(r.runtime, record, directory)
      r.admission.resolve()
      const { tabId, promptDeliveryResult } = r.launchPrompt()
      await r.workspaceRequested.promise
      markAgentLaunchesClosedByUser(WT, { kind: 'tab', tabId })
      store.getState().closeTab(tabId)
      r.runtime.getClientSettings.mockReturnValue({
        experimentalNativeChat: true,
        experimentalStructuredNativeChat: true,
        openAgentTabsInChatByDefault: true
      })
      r.start.resolve()
      r.workspace.resolve()
      await expect(promptDeliveryResult).resolves.toMatchObject({ delivered: false })
      expect(structured.attach).not.toHaveBeenCalled()
      expect(structured.publish).not.toHaveBeenCalled()
      expect(structured.send).not.toHaveBeenCalled()
      expect(structured.acquire).not.toHaveBeenCalled()
      expect(r.runtime.createTerminal).not.toHaveBeenCalled()
      expect(deliver).not.toHaveBeenCalled()
      expect(tab(tabId)).toBeUndefined()
      expect(activeAgentLaunchesFor(r.context.runtime).size).toBe(0)
      expect(isAgentLaunchRunningIn(WT, { kind: 'tab', tabId })).toBe(false)
      expect(callRuntimeRpc).toHaveBeenCalledOnce()
    }
  )

  it.each(['intent', 'host'] as const)(
    'close during structured %s preparation prevents attachment',
    async (waitAt) => {
      await record.transactOperations((draft) => draft.operations.clear())
      const r = rig({ deferWorkspace: true, rootCwd: true, structuredAi: true })
      structured = installDesktopStructuredTestHost(r.runtime, record, directory)
      const entered = deferred<void>()
      const release = deferred<void>()
      if (waitAt === 'intent') {
        const resolve = structured.resolve.getMockImplementation()!
        structured.resolve.mockImplementationOnce(async (input) => {
          entered.resolve()
          await release.promise
          return resolve(input)
        })
      } else {
        r.runtime.ensureStructuredAgentSessionHost.mockImplementationOnce(async () => {
          entered.resolve()
          await release.promise
        })
      }
      r.admission.resolve()
      const { tabId, promptDeliveryResult } = r.launchPrompt()
      await r.workspaceRequested.promise
      r.runtime.getClientSettings.mockReturnValue({
        experimentalNativeChat: true,
        experimentalStructuredNativeChat: true,
        openAgentTabsInChatByDefault: true
      })
      r.workspace.resolve()
      await entered.promise
      markAgentLaunchesClosedByUser(WT, { kind: 'tab', tabId })
      store.getState().closeTab(tabId)
      release.resolve()
      await expect(promptDeliveryResult).resolves.toMatchObject({ delivered: false })
      expect(structured.attach).not.toHaveBeenCalled()
      expect(structured.publish).not.toHaveBeenCalled()
      expect(structured.send).not.toHaveBeenCalled()
      expect(structured.acquire).not.toHaveBeenCalled()
      expect(r.runtime.createTerminal).not.toHaveBeenCalled()
      expect(tab(tabId)).toBeUndefined()
      expect(isAgentLaunchRunningIn(WT, { kind: 'tab', tabId })).toBe(false)
    }
  )

  it.each([
    { activate: false, capacity: true },
    { activate: true, capacity: true },
    { activate: false, capacity: false },
    { activate: true, capacity: false },
    { activate: false, capacity: true, canPublish: false },
    { activate: false, capacity: true, workspaceError: true }
  ])(
    'closing before workspace resolution prevents tab recreation and input (%j)',
    async (options) => {
      if (!options.capacity) {
        await record.transactOperations((draft) => draft.operations.clear())
      }
      const r = rig({ ...options, deferWorkspace: true })
      r.admission.resolve()
      const { tabId, promptDeliveryResult } = r.launchPrompt()
      await r.workspaceRequested.promise
      expect(tab(tabId)).toBeDefined()
      markAgentLaunchesClosedByUser(WT, { kind: 'tab', tabId })
      store.getState().closeTab(tabId)
      expect(tab(tabId)).toBeUndefined()
      r.start.resolve()
      r.workspace.resolve()
      await expect(promptDeliveryResult).resolves.toMatchObject({ delivered: false })
      expect(r.runtime.publishAgentLaunchTab).not.toHaveBeenCalled()
      expect(r.runtime.createTerminal).not.toHaveBeenCalled()
      expect(deliver).not.toHaveBeenCalled()
      expect(tab(tabId)).toBeUndefined()
      expect(r.mount.shellStarts).toBe(0)
      expect(activeAgentLaunchesFor(r.context.runtime).size).toBe(0)
      expect(isAgentLaunchRunningIn(WT, { kind: 'tab', tabId })).toBe(false)
    }
  )

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
