/**
 * A click's follow-up on its launch's record, against the real durable ledger: recorded with the
 * launch, taken once by the caller that made it, and never seen by any other caller.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { RpcContext } from '../core'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

const deliverTerminalPrompt = vi.hoisted(() => vi.fn(async (): Promise<boolean> => true))
const persisted = vi.hoisted(() => ({ followUps: true }))
vi.mock('../../agent-launch-persisted-obligations', () => ({
  hasPersistedLaunchObligation: () => persisted.followUps
}))
vi.mock('./agent-launch-terminal-prompt', () => ({
  deliverTerminalAgentLaunchPrompt: deliverTerminalPrompt
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const { AGENT_LAUNCH_FOLLOW_UP_METHODS, announceSettledLaunchFollowUps } =
  await import('./agent-launch-follow-ups')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
const TAKE = methodNamed(AGENT_LAUNCH_FOLLOW_UP_METHODS, 'agent.takeLaunchFollowUps')

const OPERATION_ID = `${Date.now()}-000000000000000000000000000000f1`
const PANE_KEY = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const FOLLOW_UP = { kind: 'review-notes-delivered', version: 1, payload: { worktreeId: 'wt-7' } }
const LAUNCH = {
  agent: 'claude',
  target: { kind: 'existing', worktree: 'id:wt-7' },
  prompt: { text: 'fix the notes', delivery: 'submit', transport: 'paste' },
  followUp: FOLLOW_UP,
  operationId: OPERATION_ID
}
const DESKTOP: Partial<RpcContext> = {
  caller: DESKTOP_RPC_CALLER,
  clientKind: 'runtime',
  clientCapabilities: [
    AGENT_LAUNCH_RUNTIME_CAPABILITY,
    AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY
  ]
}
const PHONE: Partial<RpcContext> = {
  clientKind: 'mobile',
  pairedDeviceId: 'device-1',
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
}

let directory: string
let store: AgentSessionRecordStore

function host(): AgentLaunchRuntimeStub {
  return runtimeStub({ settings: {}, terminalPaneKey: PANE_KEY, lineCarriesPrompt: false })
}

function launch(
  runtime: AgentLaunchRuntimeStub,
  params: unknown = LAUNCH,
  context: Partial<RpcContext> = DESKTOP
) {
  return AGENT_LAUNCH_REPLAY.handler(
    AGENT_LAUNCH_REPLAY.params.parse(params),
    rpcContext(runtime, context)
  )
}

function take(runtime: AgentLaunchRuntimeStub, context: Partial<RpcContext>, operationId?: string) {
  return TAKE.handler(
    TAKE.params.parse(operationId ? { operationId } : {}),
    rpcContext(runtime, context)
  )
}

beforeEach(async () => {
  persisted.followUps = true
  deliverTerminalPrompt.mockReset()
  deliverTerminalPrompt.mockResolvedValue(true)
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-follow-ups-'))
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
})

afterEach(async () => {
  setAgentLaunchRecordStore(null)
  await rm(directory, { recursive: true, force: true })
})

describe('a click’s follow-up on its launch’s record', () => {
  it('is recorded with the launch and taken once, by the caller that made it', async () => {
    const runtime = host()
    await launch(runtime)

    // Another caller, on a connection that proves it is someone else, sees nothing.
    await expect(take(runtime, PHONE)).resolves.toEqual({ taken: [], pending: [] })
    await expect(take(runtime, DESKTOP, OPERATION_ID)).resolves.toEqual({
      taken: [
        {
          operationId: OPERATION_ID,
          followUp: FOLLOW_UP,
          promptHandedOver: true,
          composerUnobserved: false
        }
      ],
      pending: []
    })
    await expect(take(runtime, DESKTOP)).resolves.toEqual({ taken: [], pending: [] })
  })

  it('tells the window once the launch settled its prompt, so a reloaded window takes it', async () => {
    const runtime = host()
    await launch(runtime)
    expect(runtime.reportAgentLaunchPromptSettled).toHaveBeenCalledExactlyOnceWith(OPERATION_ID)
    await take(runtime, DESKTOP, OPERATION_ID)
    // Taken: a later sweep has nothing to announce.
    announceSettledLaunchFollowUps(runtime)
    expect(runtime.reportAgentLaunchPromptSettled).toHaveBeenCalledOnce()
  })

  it('tells the window when the launch failed too, so it stops holding what the click sent', async () => {
    const runtime = host()
    runtime.createTerminal.mockRejectedValueOnce(new Error('spawn failed'))
    await expect(launch(runtime)).rejects.toThrow()
    expect(runtime.reportAgentLaunchPromptSettled).toHaveBeenCalledExactlyOnceWith(OPERATION_ID)
    await expect(take(runtime, DESKTOP, OPERATION_ID)).resolves.toMatchObject({
      taken: [{ operationId: OPERATION_ID, promptHandedOver: false }]
    })
  })

  it('answers a window load with nothing, never opening the store, when no launch recorded one', async () => {
    persisted.followUps = false
    const runtime = host()
    runtime.openedAgentSessionRecordStore.mockReturnValue(null)
    await expect(take(runtime, DESKTOP)).resolves.toEqual({ taken: [], pending: [] })
    expect(runtime.openAgentSessionRecordStore).not.toHaveBeenCalled()
  })

  it('is recorded for the desktop only: a phone, which never takes one, records nothing', async () => {
    const runtime = host()
    await launch(runtime, LAUNCH, PHONE)
    await expect(take(runtime, PHONE)).resolves.toEqual({ taken: [], pending: [] })
    expect(store.listOperationRows().some((row) => row.launchFollowUp !== undefined)).toBe(false)
  })

  it('outlives a host restart until it is taken', async () => {
    await launch(host())
    store = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(store)

    const after = await take(host(), DESKTOP)
    expect(after.taken.map((entry) => entry.operationId)).toEqual([OPERATION_ID])
  })

  it('keeps a reloaded window pending until the live host finishes its one prompt', async () => {
    const runtime = host()
    let complete: (value: boolean) => void = () => {}
    let started: () => void = () => {}
    const promptStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    deliverTerminalPrompt.mockImplementationOnce(() => {
      started()
      return new Promise<boolean>((resolve) => {
        complete = resolve
      })
    })
    const running = launch(runtime)
    await promptStarted
    // Flush the provisional receipt fired before the live prompt started.
    await store.recordOperationOutcome({
      callerKey: 'absent',
      operationId: 'absent',
      outcome: { status: 'unknown' }
    })

    const expectedPending = {
      taken: [],
      pending: [{ operationId: OPERATION_ID, followUp: FOLLOW_UP }]
    }
    await expect(take(runtime, DESKTOP)).resolves.toEqual(expectedPending)
    announceSettledLaunchFollowUps(runtime)
    expect(runtime.reportAgentLaunchPromptSettled).not.toHaveBeenCalled()
    const replay = launch(runtime)
    expect(deliverTerminalPrompt).toHaveBeenCalledOnce()

    complete(true)
    const [result, retry] = await Promise.all([running, replay])
    expect(retry).toEqual(result)
    expect(runtime.reportAgentLaunchPromptSettled).toHaveBeenCalledExactlyOnceWith(OPERATION_ID)
    expect((await take(runtime, DESKTOP)).taken[0]).toMatchObject({ promptHandedOver: true })
    await expect(take(runtime, DESKTOP)).resolves.toEqual({ taken: [], pending: [] })
    expect(deliverTerminalPrompt).toHaveBeenCalledOnce()
  })

  it('consumes a restarted interrupted launch without executing its follow-up or pasting later', async () => {
    let started: () => void = () => {}
    const promptStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    deliverTerminalPrompt.mockImplementationOnce(() => {
      started()
      return new Promise<boolean>(() => {})
    })
    void launch(host())
    await promptStarted
    await store.recordOperationOutcome({
      callerKey: 'absent',
      operationId: 'absent',
      outcome: { status: 'unknown' }
    })
    store = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(store)

    const restarted = host()
    const result = await launch(restarted)
    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'unconfirmed' })
    expect((await take(restarted, DESKTOP)).taken[0]).toMatchObject({ promptHandedOver: false })
    await expect(take(restarted, DESKTOP)).resolves.toEqual({ taken: [], pending: [] })
    expect(restarted.createTerminal).not.toHaveBeenCalled()
    expect(deliverTerminalPrompt).toHaveBeenCalledOnce()
  })

  it('does not authorize a follow-up on bare terminal creation', async () => {
    const runtime = host()
    await launch(runtime, { ...LAUNCH, prompt: undefined })

    expect((await take(runtime, DESKTOP)).taken[0]).toMatchObject({ promptHandedOver: false })
    expect(deliverTerminalPrompt).not.toHaveBeenCalled()
  })

  it('allows concurrent callers to take a settled follow-up only once', async () => {
    const runtime = host()
    await launch(runtime)
    const results = await Promise.all([take(runtime, DESKTOP), take(runtime, DESKTOP)])
    expect(results.flatMap((result) => result.taken)).toHaveLength(1)
    await expect(take(runtime, DESKTOP)).resolves.toEqual({ taken: [], pending: [] })
  })

  it('does not announce another caller’s completed launch with the same operation id as a pending desktop launch', async () => {
    const runtime = host()
    let complete: (value: boolean) => void = () => {}
    let started: () => void = () => {}
    const promptStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    deliverTerminalPrompt.mockImplementationOnce(() => {
      started()
      return new Promise<boolean>((resolve) => {
        complete = resolve
      })
    })
    const running = launch(runtime)
    await promptStarted
    try {
      expect((await take(runtime, DESKTOP)).pending).toMatchObject([{ operationId: OPERATION_ID }])
      await launch(runtime, LAUNCH, PHONE)
      expect(runtime.reportAgentLaunchPromptSettled).not.toHaveBeenCalled()
    } finally {
      complete(true)
      await running
    }
    expect(runtime.reportAgentLaunchPromptSettled).toHaveBeenCalledExactlyOnceWith(OPERATION_ID)
    expect((await take(runtime, DESKTOP)).taken).toHaveLength(1)
    await expect(take(runtime, DESKTOP)).resolves.toEqual({ taken: [], pending: [] })
  })

  it('is not recorded over the size cap, and the launch still runs', async () => {
    const runtime = host()
    const huge = { ...FOLLOW_UP, payload: { blob: 'x'.repeat(300 * 1024) } }

    const result = await launch(runtime, { ...LAUNCH, followUp: huge })

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    await expect(take(runtime, DESKTOP)).resolves.toEqual({ taken: [], pending: [] })
  })

  it('is not part of what the launch is: a retry that names another follow-up replays it', async () => {
    const runtime = host()
    const first = await launch(runtime)
    await expect(
      launch(runtime, { ...LAUNCH, followUp: { ...FOLLOW_UP, version: 2 } })
    ).resolves.toEqual(first)
    expect(runtime.createTerminal).toHaveBeenCalledOnce()
  })
})
