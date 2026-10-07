import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentLaunchReplay } from '../../../../shared/rpc-contract/agent-launch-params'
import { computeAgentLaunchFingerprint } from '../../../../shared/agent-launch-operation'
import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import { desktopNewTabPromptDelivery } from '../../../../shared/desktop-new-tab-prompt'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_DESKTOP_NEW_TAB_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import { admitAgentLaunchOperation } from './agent-launch-replay'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore
} from './agent-launch.test-fixture'
import { AGENT_LAUNCH_METHODS } from './agent-launch'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import { resumeOwedLaunchPrompts } from '../../../agent-launch/agent-launch-owed-prompt-resume'
import {
  settledAtCreation,
  promptReceipt
} from '../../../agent-launch/agent-launch-prompt-delivery'
import { writeDesktopNewTabPrompt } from '../../desktop-new-tab-prompt-writer'
import { BRACKETED_PASTE_START } from '../../../../shared/terminal-bracketed-paste-text'

let directory: string
let store: AgentSessionRecordStore
beforeEach(async () => {
  directory = await mkdtemp(
    join(process.env.ORCA_STEP4_TEST_STATE_DIR ?? tmpdir(), 'desktop-launch-')
  )
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
})
afterEach(() => setAgentLaunchRecordStore(null))

const PANE = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
const CALLER = {
  caller: DESKTOP_RPC_CALLER,
  clientKind: 'runtime',
  clientCapabilities: [
    AGENT_LAUNCH_RUNTIME_CAPABILITY,
    AGENT_LAUNCH_DESKTOP_NEW_TAB_RUNTIME_CAPABILITY,
    AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY
  ]
} as const
const receipt = {
  mode: 'terminal',
  preferred: 'terminal',
  reason: 'user_default',
  detail: 'User chose terminal'
} as const

const cases = [
  { agent: 'claude', mode: 'draft', text: 'draft' },
  { agent: 'aider', mode: 'auto-submit', text: 'automatic stdin draft' },
  { agent: 'claude', mode: 'submit-after-ready', text: 'submitted live paste' },
  { agent: 'claude', mode: 'auto-submit', text: ' \n ' }
] as const

describe('desktop compatibility records admission without a new future paste', () => {
  for (const scenario of cases) {
    for (const wroteFirstByte of [false, true]) {
      it(`${scenario.agent} ${scenario.mode} ${JSON.stringify(scenario.text)} interruption ${wroteFirstByte ? 'after' : 'before'} first byte never replays startup or paste`, async () => {
        const params = AgentLaunchReplay.parse({
          agent: scenario.agent,
          target: { kind: 'existing', worktree: 'folder:test' },
          paneKey: PANE,
          operationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
          prompt: {
            text:
              wroteFirstByte && scenario.text.trim()
                ? scenario.text + 'x'.repeat(70_000)
                : scenario.text,
            delivery: desktopNewTabPromptDelivery(scenario.agent, scenario.mode),
            transport: { kind: 'desktop-new-tab', promptDelivery: scenario.mode }
          }
        })
        const runtime = runtimeStub({ settings: {}, adoptedPanes: { [PANE]: 'surviving-handle' } })
        const context = rpcContext(runtime, CALLER)
        const fingerprint = computeAgentLaunchFingerprint(params)
        const admitted = await admitAgentLaunchOperation(context, params, fingerprint)
        expect(admitted.decision).toBe('execute')
        if (admitted.decision !== 'execute') {
          throw new Error('missing admission')
        }
        const provisional: AgentLaunchResult = {
          outcome: { kind: 'terminal', handle: 'first-handle', paneKey: PANE },
          worktreeId: 'folder:test',
          receipt,
          ...promptReceipt(params, settledAtCreation(params, {}))
        }
        await admitted.record(provisional, {
          ptyId: 'first-pty',
          incarnationId: 'first-incarnation'
        })
        expect(store.listOperationRows()[0]?.promptDelivery).toBeUndefined()
        if (scenario.text.trim()) {
          expect(provisional.prompt).toEqual({
            delivery: params.prompt?.delivery,
            outcome: 'unconfirmed'
          })
        } else {
          expect(provisional).not.toHaveProperty('prompt')
        }
        const written: string[] = []
        if (scenario.text.trim()) {
          expect(await admitted.beginPromptWrite()).toBe('absent')
          await expect(
            writeDesktopNewTabPrompt({
              text: params.prompt?.text.trim() ?? '',
              agent: scenario.agent,
              submit: params.prompt?.delivery === 'submit',
              delay: async () => undefined,
              write: async (data) => {
                if (wroteFirstByte && written.length === 0) {
                  written.push(data)
                  return true
                }
                throw new Error('terminal_not_writable')
              }
            })
          ).rejects.toThrow('terminal_not_writable')
        }
        const expectedWrites = wroteFirstByte && scenario.text.trim() ? [BRACKETED_PASTE_START] : []
        expect(written).toEqual(expectedWrites)
        const deliver = vi.fn(async () => true)
        store = await openTestAgentSessionRecordStore(directory)
        setAgentLaunchRecordStore(store)
        expect(
          await resumeOwedLaunchPrompts({
            store,
            terminalForPane: () => ({
              handle: 'surviving-handle',
              terminal: { ptyId: 'first-pty', incarnationId: 'first-incarnation' }
            }),
            deliver,
            isLaunchRunning: () => false,
            now: () => Date.now()
          })
        ).toBe(false)
        expect(deliver).not.toHaveBeenCalled()
        const replayed = await admitAgentLaunchOperation(context, params, fingerprint)
        expect(replayed).toEqual({
          decision: 'replay',
          result: {
            ...provisional,
            outcome: { ...provisional.outcome, handle: 'surviving-handle' }
          }
        })
        if (replayed.decision !== 'replay') {
          throw new Error('missing replay')
        }
        expect(await REPLAY.handler(params, context)).toEqual(replayed.result)
        expect(runtime.createTerminal).not.toHaveBeenCalled()
        expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
        expect(store.listOperationRows()).toHaveLength(1)
        expect(written).toEqual(expectedWrites)
      })
    }
  }
  it('retains the existing bounded legacy desktop submitted-paste obligation', async () => {
    const params = AgentLaunchReplay.parse({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'folder:test' },
      operationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
      prompt: { text: 'legacy paste', delivery: 'submit', transport: 'paste' }
    })
    const admitted = await admitAgentLaunchOperation(
      rpcContext(runtimeStub({ settings: {} }), CALLER),
      params,
      computeAgentLaunchFingerprint(params)
    )
    if (admitted.decision !== 'execute') {
      throw new Error('missing admission')
    }
    await admitted.record(
      {
        outcome: { kind: 'terminal', handle: 'legacy', paneKey: PANE },
        worktreeId: 'folder:test',
        receipt,
        prompt: { delivery: 'submit', outcome: 'unconfirmed' }
      },
      { ptyId: 'first-pty', incarnationId: null }
    )
    expect(store.listOperationRows()[0]?.promptDelivery).toMatchObject({
      state: 'owed',
      text: 'legacy paste',
      terminal: { ptyId: 'first-pty', incarnationId: null }
    })
  })
})
