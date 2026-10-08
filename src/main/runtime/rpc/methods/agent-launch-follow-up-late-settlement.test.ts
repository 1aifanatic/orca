import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentLaunchFollowUpTake } from '../../../../shared/agent-launch-follow-up'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from '../../../../shared/agent-session-host-authority'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import { createAgentPromptSubmissionRuntime } from '../../agent-prompt-submission-runtime-test-fixture'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore
} from './agent-launch.test-fixture'
import { createLaunchFollowUpWindow } from './agent-launch-follow-up-window.test-fixture'

const windowState = vi.hoisted(() => {
  const holds: Promise<unknown>[] = []
  return {
    take: vi.fn<(params: unknown) => Promise<AgentLaunchFollowUpTake>>(),
    clearNotes: vi.fn(async () => true),
    resolveThreads: vi.fn(async () => {}),
    holds
  }
})
vi.mock('../../../git/worktree', () => ({
  listWorktrees: async () => [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature',
      isBare: false,
      isMainWorktree: false
    }
  ],
  listWorktreesStrict: async () => [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature',
      isBare: false,
      isMainWorktree: false
    }
  ]
}))
vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), removeListener: vi.fn() } }))
vi.mock('../../../ipc/worktree-change-invalidators', () => ({
  runWorktreeChangeInvalidators: vi.fn(),
  registerWorktreeChangeInvalidator: vi.fn()
}))
vi.mock('../../../window/mobile-markdown-request-relay', () => ({
  requestMobileMarkdownFromRenderer: vi.fn()
}))
vi.mock('../../../window/session-tab-close-request-relay', () => ({
  requestSessionTabCloseFromRenderer: vi.fn()
}))
vi.mock('../../../window/terminal-tab-close-request-relay', () => ({
  requestTerminalTabCloseFromRenderer: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ clearDeliveredDiffComments: windowState.clearNotes }) }
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: async () => [AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY],
  readLocalRuntimeCapabilitiesOrUnknown: () => [AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY]
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (_target: unknown, _method: string, params: unknown) => windowState.take(params)
}))
vi.mock('@/lib/notes-send-in-flight', () => ({
  diffCommentSendKey: (note: { id: string }) => note.id,
  holdNotesForSend: (_keys: unknown, done: Promise<unknown>) => windowState.holds.push(done)
}))
vi.mock('@/components/right-sidebar/pr-comment-groups-in-flight', () => ({
  holdPRCommentGroupsForSend: (_keys: unknown, done: Promise<unknown>) =>
    windowState.holds.push(done)
}))
vi.mock('@/components/right-sidebar/review-comments-resolution-follow-up', () => ({
  runReviewCommentsResolutionFollowUp: windowState.resolveThreads
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const { AGENT_LAUNCH_FOLLOW_UP_METHODS, announceSettledLaunchFollowUps } =
  await import('./agent-launch-follow-ups')
const { runRecordedLaunchFollowUps } =
  await import('../../../../renderer/src/lib/agent-launch-follow-up-waiter')
const { reviewNotesDeliveredFollowUp, reviewCommentsResolutionFollowUp } =
  await import('../../../../renderer/src/lib/agent-launch-follow-ups')
const LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
const TAKE = methodNamed(AGENT_LAUNCH_FOLLOW_UP_METHODS, 'agent.takeLaunchFollowUps')
const DESKTOP = {
  caller: DESKTOP_RPC_CALLER,
  clientKind: 'runtime' as const,
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY, AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY]
}
const PANE_KEY = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const EXPIRED_HANDOFF_MS =
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1

let directory: string
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  windowState.take.mockReset()
  windowState.clearNotes.mockClear()
  windowState.resolveThreads.mockClear()
  windowState.holds = []
  directory = await mkdtemp(join(tmpdir(), 'orca-late-launch-follow-up-'))
  setAgentLaunchRecordStore(await openTestAgentSessionRecordStore(directory))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  setAgentLaunchRecordStore(null)
  await rm(directory, { recursive: true, force: true })
})

it.each([
  {
    kind: 'notes',
    cancelNavigation: false,
    lookupFails: false,
    elapsedMs: 315_001,
    rowState: 'live'
  },
  {
    kind: 'checks',
    cancelNavigation: false,
    lookupFails: false,
    elapsedMs: 315_001,
    rowState: 'live'
  },
  {
    kind: 'notes',
    cancelNavigation: true,
    lookupFails: false,
    elapsedMs: 315_001,
    rowState: 'live'
  },
  {
    kind: 'checks',
    cancelNavigation: true,
    lookupFails: false,
    elapsedMs: 315_001,
    rowState: 'live'
  },
  { kind: 'notes', cancelNavigation: false, lookupFails: true, elapsedMs: 1_000, rowState: 'live' },
  {
    kind: 'checks',
    cancelNavigation: false,
    lookupFails: true,
    elapsedMs: 1_000,
    rowState: 'live'
  },
  {
    kind: 'notes',
    cancelNavigation: false,
    lookupFails: true,
    elapsedMs: 315_001,
    rowState: 'live'
  },
  {
    kind: 'checks',
    cancelNavigation: false,
    lookupFails: true,
    elapsedMs: 315_001,
    rowState: 'live'
  },
  {
    kind: 'notes',
    cancelNavigation: false,
    lookupFails: false,
    elapsedMs: EXPIRED_HANDOFF_MS,
    rowState: 'expired'
  },
  {
    kind: 'checks',
    cancelNavigation: false,
    lookupFails: false,
    elapsedMs: EXPIRED_HANDOFF_MS,
    rowState: 'expired'
  },
  {
    kind: 'notes',
    cancelNavigation: false,
    lookupFails: false,
    elapsedMs: EXPIRED_HANDOFF_MS,
    rowState: 'pruned'
  },
  {
    kind: 'checks',
    cancelNavigation: false,
    lookupFails: false,
    elapsedMs: EXPIRED_HANDOFF_MS,
    rowState: 'pruned'
  }
] as const)(
  'settles $kind after a guarded handoff at $elapsedMs ms ($rowState row, canceled navigation: $cancelNavigation, failed lookup: $lookupFails)',
  async ({ kind, cancelNavigation, lookupFails, elapsedMs, rowState }) => {
    const rig = await createAgentPromptSubmissionRuntime(() => {}, 'opencode')
    vi.spyOn(rig.runtime, 'waitForFreshWorkerComposer').mockResolvedValue({
      handle: rig.handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    let allowForeground: (value: 'agent') => void = () => {}
    let started: () => void = () => {}
    const guardStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const foreground = new Promise<'agent'>((resolve) => {
      allowForeground = resolve
    })
    vi.mocked(rig.runtime.readLaunchedAgentForeground).mockImplementationOnce(() => {
      started()
      return foreground
    })
    const runtime = Object.assign(
      runtimeStub({ settings: {}, terminalPaneKey: PANE_KEY, lineCarriesPrompt: false }),
      {
        getTerminalPromptRequestBinding: rig.runtime.getTerminalPromptRequestBinding.bind(
          rig.runtime
        ),
        waitForFreshWorkerComposer: rig.runtime.waitForFreshWorkerComposer.bind(rig.runtime),
        waitForTerminal: rig.runtime.waitForTerminal.bind(rig.runtime),
        waitForAgentLaunchFallback: rig.runtime.waitForAgentLaunchFallback.bind(rig.runtime),
        readLaunchedAgentForeground: rig.runtime.readLaunchedAgentForeground.bind(rig.runtime),
        subscribeToTerminalData: rig.runtime.subscribeToTerminalData.bind(rig.runtime),
        sendTerminalAgentPrompt: rig.runtime.sendTerminalAgentPrompt.bind(rig.runtime)
      }
    )
    runtime.createTerminal.mockResolvedValue({ handle: rig.handle, paneKey: PANE_KEY })
    const context = rpcContext(runtime, DESKTOP)
    const t = createLaunchFollowUpWindow(runtime, context.runtime)
    windowState.take.mockImplementation((params) =>
      TAKE.handler(TAKE.params.parse(params), context)
    )
    const note = { id: 'n1', body: 'fix this', filePath: 'a.ts', lineNumber: 3 }
    const followUp =
      kind === 'notes'
        ? reviewNotesDeliveredFollowUp('wt-7', [note])
        : reviewCommentsResolutionFollowUp({
            reviewContextKey: 'pr-1',
            provider: 'github',
            selectedGroups: [
              {
                kind: 'comment',
                comment: {
                  id: 7,
                  author: 'reviewer',
                  authorAvatarUrl: '',
                  body: 'fix this',
                  createdAt: '2026-01-01T00:00:00Z',
                  url: 'https://example.test/c/7'
                }
              }
            ]
          })
    const operationId = `${Date.now()}-000000000000000000000000000000f${kind === 'notes' ? '1' : '2'}`
    const running = LAUNCH.handler(
      LAUNCH.params.parse({
        agent: 'opencode',
        target: { kind: 'existing', worktree: 'id:wt-7' },
        prompt: { text: 'fix this', delivery: 'submit', transport: 'paste' },
        followUp,
        operationId
      }),
      context
    )
    await guardStarted
    let finished = false
    const windowRun = runRecordedLaunchFollowUps(t.clock).then(() => {
      finished = true
    })
    try {
      await vi.waitFor(() => expect(windowState.holds).toHaveLength(1))
      const probeElapsed = Math.min(elapsedMs, 315_001)
      t.advance(probeElapsed)
      const probeIndex = elapsedMs > 315_000 ? 1 : 0
      await vi.waitFor(() => expect(windowState.take).toHaveBeenCalledTimes(probeIndex + 1))
      await vi.waitFor(async () => {
        const probe = await windowState.take.mock.results[probeIndex]!.value
        expect(probe.pending).toMatchObject([{ operationId }])
      })
      await Promise.resolve()
      expect(finished).toBe(false)
      expect(t.listenerCount).toBe(1)
      expect(rig.writes).toEqual([])
      if (rowState !== 'live') {
        t.advance(elapsedMs - probeElapsed)
        const store = runtime.openedAgentSessionRecordStore()
        if (!store) {
          throw new Error('missing launch store')
        }
        const row = store.listOperationRows().find((entry) => entry.operationId === operationId)
        expect(row?.expiresAt).toBeLessThan(Date.now())
        if (rowState === 'pruned') {
          await store.admitOperation({
            callerKey: 'unrelated',
            operationId: `${Date.now()}-000000000000000000000000000000f3`,
            fingerprint: 'unrelated-operation',
            now: Date.now()
          })
          expect(store.listOperationRows().some((entry) => entry.operationId === operationId)).toBe(
            false
          )
        }
      }
      if (cancelNavigation) {
        t.webContents.emit('did-start-navigation', {}, 'https://example.test/reload', false, true)
      }
      if (lookupFails) {
        windowState.take.mockRejectedValueOnce(new Error('runtime_unavailable'))
      }
      allowForeground('agent')
      const result = await running
      expect(result.prompt?.outcome).toBe('handed-to-terminal')
      if (cancelNavigation) {
        expect(t.send).not.toHaveBeenCalled()
        expect(finished).toBe(false)
        t.webContents.emit('did-stop-loading')
        expect(t.send).toHaveBeenCalledExactlyOnceWith('ui:agentLaunchPromptSettled', {
          operationId
        })
        announceSettledLaunchFollowUps(runtime)
        announceSettledLaunchFollowUps(runtime)
      }
      await vi.waitFor(() => expect(finished).toBe(true))
      await windowRun
      expect(rig.writes).toEqual(['\x1b[200~fix this\x1b[201~', '\r'])
      expect(runtime.reportAgentLaunchPromptSettled).toHaveBeenCalledWith(operationId)
      if (rowState !== 'live') {
        expect(windowState.clearNotes).not.toHaveBeenCalled()
        expect(windowState.resolveThreads).not.toHaveBeenCalled()
        await expect(windowState.holds[0]).resolves.toBeUndefined()
        expect(t.listenerCount).toBe(0)
        announceSettledLaunchFollowUps(runtime)
        await runRecordedLaunchFollowUps(t.clock)
        await expect(TAKE.handler(TAKE.params.parse({ operationId }), context)).resolves.toEqual({
          taken: [],
          pending: []
        })
        expect(windowState.clearNotes).not.toHaveBeenCalled()
        expect(windowState.resolveThreads).not.toHaveBeenCalled()
        return
      }
      if (lookupFails) {
        expect(windowState.clearNotes).not.toHaveBeenCalled()
        expect(windowState.resolveThreads).not.toHaveBeenCalled()
        await expect(windowState.holds[0]).resolves.toBeUndefined()
        expect(t.listenerCount).toBe(0)
        expect(runtime.openedAgentSessionRecordStore()?.listOperationRows()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ operationId, launchFollowUp: followUp })
          ])
        )
        await runRecordedLaunchFollowUps(t.clock)
      }
      expect(
        kind === 'notes' ? windowState.clearNotes : windowState.resolveThreads
      ).toHaveBeenCalledOnce()
      announceSettledLaunchFollowUps(runtime)
      announceSettledLaunchFollowUps(runtime)
      await Promise.resolve()
      expect(
        kind === 'notes' ? windowState.clearNotes : windowState.resolveThreads
      ).toHaveBeenCalledOnce()
      await expect(windowState.holds[0]).resolves.toBeUndefined()
      expect(t.listenerCount).toBe(0)
      await expect(TAKE.handler(TAKE.params.parse({ operationId }), context)).resolves.toEqual({
        taken: [],
        pending: []
      })
    } finally {
      allowForeground('agent')
      await running
    }
  }
)
