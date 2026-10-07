import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from '../../agent-prompt-submission-runtime-test-fixture'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import { settledWriteStub } from '../../../providers/settled-pty-write-stub'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import type { RpcContext } from '../core'
import { methodNamed } from './agent-launch.test-fixture'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import { desktopNewTabPromptDelivery } from '../../../../shared/desktop-new-tab-prompt'
import { wrapTerminalBracketedPasteText } from '../../../../shared/terminal-bracketed-paste-text'

vi.mock('../../../git/worktree', () => ({
  listWorktrees: vi
    .fn()
    .mockResolvedValue([
      { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
    ]),
  listWorktreesStrict: vi
    .fn()
    .mockResolvedValue([
      { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
    ])
}))
// Exercise the additive route without advertising it to production clients.
vi.mock('./agent-launch-desktop-prompt-compatibility', () => ({
  requireDesktopPromptCompatibility: () => {}
}))
const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
type SpawnOptions = Parameters<NonNullable<RuntimePtyController['spawn']>>[0]
const PANE = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const cases = [
  { agent: 'claude', mode: 'submit-after-ready', text: "first '🦄'\nsecond\x1b", pasted: true },
  { agent: 'aider', mode: 'auto-submit', text: 'editable stdin draft', pasted: true },
  { agent: 'claude', mode: 'draft', text: 'native prefill', pasted: false },
  { agent: 'claude', mode: 'auto-submit', text: ' \n\r\t ', pasted: false }
] as const

describe('desktop live input uses the existing optional-identity public route', () => {
  afterEach(() => vi.useRealTimers())
  for (const recorded of [false, true]) {
    for (const scenario of cases) {
      it(`${recorded ? 'recorded' : 'unrecorded'} ${scenario.agent} ${scenario.mode} retains host planning and exact input`, async () => {
        vi.useFakeTimers()
        const { runtime } = await createAgentPromptSubmissionRuntime(
          () => undefined,
          scenario.agent
        )
        const directory = await mkdtemp(
          join(process.env.ORCA_STEP4_TEST_STATE_DIR ?? tmpdir(), 'public-launch-')
        )
        const store = await openTestAgentSessionRecordStore(directory)
        const open = vi.spyOn(runtime, 'openAgentSessionRecordStore').mockResolvedValue(store)
        vi.spyOn(runtime, 'openedAgentSessionRecordStore').mockReturnValue(recorded ? store : null)
        const report = vi.spyOn(runtime, 'reportAgentLaunchPromptSettled')
        const writes: string[] = []
        const times: number[] = []
        const write = (_id: string, data: string) => {
          writes.push(data)
          times.push(Date.now())
          return true
        }
        const spawn = vi.fn(async (_opts: SpawnOptions) => ({
          id: 'pty-public',
          incarnationId: 'public-incarnation'
        }))
        runtime.setPtyController({
          spawn,
          write,
          writeWithSettlement: settledWriteStub(write),
          kill: () => true,
          getForegroundProcess: async () => null
        })
        const ready = vi
          .spyOn(runtime, 'waitForFreshWorkerComposer')
          .mockImplementation(async (handle) => ({
            handle,
            condition: 'tui-idle',
            satisfied: true,
            status: 'running',
            exitCode: null
          }))
        const context: RpcContext = {
          runtime,
          caller: DESKTOP_RPC_CALLER,
          clientKind: 'runtime',
          clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
        }
        const params = LAUNCH.params.parse({
          agent: scenario.agent,
          target: { kind: 'existing', worktree: 'path:/tmp/worktree-a' },
          paneKey: PANE,
          ...(recorded ? { operationId: `${Date.now()}-0123456789abcdef0123456789abcdef` } : {}),
          followUp: { kind: 'review-notes-delivered', version: 1, payload: { noteIds: ['n1'] } },
          prompt: {
            text: scenario.text,
            delivery: desktopNewTabPromptDelivery(scenario.agent, scenario.mode),
            transport: { kind: 'desktop-new-tab', promptDelivery: scenario.mode }
          }
        })
        const pending = recorded
          ? REPLAY.handler(REPLAY.params.parse(params), context)
          : LAUNCH.handler(params, context)
        if (scenario.pasted) {
          await vi.waitFor(() =>
            expect(writes).toHaveLength(params.prompt?.delivery === 'submit' ? 2 : 1)
          )
        }
        await vi.runAllTimersAsync()
        const result = await pending
        expect(spawn).toHaveBeenCalledOnce()
        expect(spawn.mock.calls[0]?.[0]).toMatchObject({
          tabId: PANE.split(':')[0],
          leafId: PANE.split(':')[1],
          launchAgent: scenario.agent
        })
        if (scenario.pasted) {
          expect(ready).toHaveBeenCalledOnce()
          const submitted = params.prompt?.delivery === 'submit'
          expect(writes).toEqual([
            wrapTerminalBracketedPasteText(scenario.text),
            ...(submitted ? ['\r'] : [])
          ])
          if (submitted) {
            expect(times[1] - times[0]).toBe(50)
          }
          expect(result.prompt).toMatchObject({ outcome: 'handed-to-terminal' })
        } else {
          expect(ready).not.toHaveBeenCalled()
          expect(writes).toEqual([])
          if (scenario.text.trim()) {
            expect(spawn.mock.calls[0]?.[0].command).toContain('--prefill')
            expect(spawn.mock.calls[0]?.[0].command).toContain('native prefill')
            expect(result.prompt).toMatchObject({
              delivery: 'draft',
              outcome: 'handed-to-terminal'
            })
          } else {
            expect(result).not.toHaveProperty('prompt')
          }
        }
        if (recorded) {
          expect(open).toHaveBeenCalled()
          expect(store.listOperationRows()).toHaveLength(1)
          expect(store.listOperationRows()[0]?.launchFollowUp).toMatchObject({
            kind: 'review-notes-delivered'
          })
          expect(store.listOperationRows()[0]?.promptDelivery).toBeUndefined()
          expect(await REPLAY.handler(REPLAY.params.parse(params), context)).toEqual(result)
          expect(spawn).toHaveBeenCalledOnce()
        } else {
          expect(open).not.toHaveBeenCalled()
          expect(store.listOperationRows()).toEqual([])
          expect(report).not.toHaveBeenCalled()
          expect(REPLAY.params.safeParse(params).success).toBe(false)
        }
      })
    }
  }
})
