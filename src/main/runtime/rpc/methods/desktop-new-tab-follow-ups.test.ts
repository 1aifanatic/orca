import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchFollowUpTake } from '../../../../shared/agent-launch-follow-up'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_DESKTOP_NEW_TAB_CLIENT_CAPABILITY,
  AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore
} from './agent-launch.test-fixture'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import { activeAgentLaunchesFor } from './agent-launch-active-operations'

const delivery = vi.hoisted(() =>
  vi.fn(async (_args: { onWriteUnconfirmed?: () => void }): Promise<boolean> => true)
)
vi.mock('./agent-launch-terminal-prompt', () => ({
  deliverTerminalAgentLaunchPrompt: delivery
}))
const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const { AGENT_LAUNCH_FOLLOW_UP_METHODS, announceSettledLaunchFollowUps } =
  await import('./agent-launch-follow-ups')
const LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
const TAKE = methodNamed(AGENT_LAUNCH_FOLLOW_UP_METHODS, 'agent.takeLaunchFollowUps')
const FOLLOW_UP = { kind: 'review-notes-delivered', version: 1, payload: { noteIds: ['n1'] } }
const CALLER = {
  caller: DESKTOP_RPC_CALLER,
  clientKind: 'runtime',
  clientCapabilities: [
    AGENT_LAUNCH_RUNTIME_CAPABILITY,
    AGENT_LAUNCH_DESKTOP_NEW_TAB_CLIENT_CAPABILITY,
    AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY
  ]
} as const

let directory: string
let store: AgentSessionRecordStore
beforeEach(async () => {
  delivery.mockReset()
  directory = await mkdtemp(join(process.env.ORCA_STEP4_TEST_STATE_DIR ?? tmpdir(), 'follow-ups-'))
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
})
afterEach(() => setAgentLaunchRecordStore(null))

describe('a reloaded desktop retains its live compatibility follow-up', () => {
  for (const outcome of ['handed-over', 'not-delivered', 'partial', 'interrupted'] as const) {
    it(`takes the follow-up once after ${outcome}, without a future paste`, async () => {
      let finishDelivery: (value: boolean) => void = () => {}
      let interruptDelivery: (error: Error) => void = () => {}
      let enteredDelivery: () => void = () => {}
      const entered = new Promise<void>((resolve) => {
        enteredDelivery = resolve
      })
      delivery.mockImplementationOnce(async (args) => {
        if (outcome === 'partial' || outcome === 'interrupted') {
          args.onWriteUnconfirmed?.()
        }
        enteredDelivery()
        return new Promise<boolean>((resolve, reject) => {
          finishDelivery = resolve
          interruptDelivery = reject
        })
      })
      const runtime = runtimeStub({
        settings: {},
        terminalPaneKey:
          '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        lineCarriesPrompt: false
      })
      const context = rpcContext(runtime, CALLER)
      const params = LAUNCH.params.parse({
        agent: 'claude',
        target: { kind: 'existing', worktree: 'folder:test' },
        operationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
        prompt: {
          text: 'fix these notes',
          delivery: 'submit',
          transport: { kind: 'desktop-new-tab', promptDelivery: 'submit-after-ready' }
        },
        followUp: FOLLOW_UP
      })
      const take = () => TAKE.handler(TAKE.params.parse({}), context)
      const pendingLaunch = LAUNCH.handler(params, context)
      const result = pendingLaunch.catch((error: unknown) => error)
      await Promise.race([entered, pendingLaunch])
      // Flush the real provisional record transaction before the reload asks.
      await store.transactOperations(() => undefined)
      expect(store.listOperationRows()[0]).toMatchObject({
        outcome: { status: 'succeeded', launch: { prompt: { outcome: 'unconfirmed' } } },
        launchFollowUp: FOLLOW_UP
      })
      expect(activeAgentLaunchesFor(context.runtime).size).toBe(1)
      expect(await take()).toEqual({
        taken: [],
        pending: [{ operationId: params.operationId, followUp: FOLLOW_UP }]
      })
      // An early sweep may announce the provisional row. It must retain ownership.
      announceSettledLaunchFollowUps(runtime)
      expect(await take()).toMatchObject({ taken: [], pending: [{ followUp: FOLLOW_UP }] })
      runtime.reportAgentLaunchPromptSettled.mockClear()
      let notificationTake: Promise<AgentLaunchFollowUpTake> | undefined
      runtime.reportAgentLaunchPromptSettled.mockImplementation(() => {
        expect(activeAgentLaunchesFor(context.runtime).size).toBe(0)
        notificationTake = take()
      })
      if (outcome === 'interrupted') {
        interruptDelivery(new Error('transport interrupted'))
      } else {
        finishDelivery(outcome === 'handed-over')
      }
      const settled = await result
      if (outcome === 'interrupted') {
        expect(settled).toBeInstanceOf(Error)
      } else {
        expect(settled).toMatchObject({
          prompt: {
            outcome:
              outcome === 'handed-over'
                ? 'handed-to-terminal'
                : outcome === 'partial'
                  ? 'unconfirmed'
                  : 'not-delivered'
          }
        })
      }
      expect(runtime.reportAgentLaunchPromptSettled).toHaveBeenCalledExactlyOnceWith(
        params.operationId
      )
      expect(await notificationTake).toMatchObject({
        pending: [],
        taken: [{ followUp: FOLLOW_UP, promptHandedOver: outcome === 'handed-over' }]
      })
      expect(await take()).toEqual({ taken: [], pending: [] })
      store = await openTestAgentSessionRecordStore(directory)
      setAgentLaunchRecordStore(store)
      expect(await take()).toEqual({ taken: [], pending: [] })
      if (outcome !== 'interrupted') {
        expect(await LAUNCH.handler(params, context)).toEqual(settled)
      }
      expect(runtime.createTerminal).toHaveBeenCalledOnce()
      expect(delivery).toHaveBeenCalledOnce()
    })
  }
})
