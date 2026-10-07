import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { TerminalProcessInspection } from '../../../../shared/terminal-process-inspection'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import { wrapTerminalBracketedPasteText } from '../../../../shared/terminal-bracketed-paste-text'
import { createAgentPromptSubmissionRuntime } from '../../agent-prompt-submission-runtime-test-fixture'
import { settledWriteStub } from '../../../providers/settled-pty-write-stub'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import type { RpcContext } from '../core'
import { methodNamed } from './agent-launch.test-fixture'

vi.mock('../../../git/worktree', () => {
  const list = async () => [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
  ]
  return { listWorktrees: list, listWorktreesStrict: list }
})
// The production capability stays disabled; only its admission gate is opened in this fixture.
vi.mock('./agent-launch-desktop-prompt-compatibility', () => ({
  requireDesktopPromptCompatibility: () => {}
}))
const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const PANE = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const TEXT = "first '🦄'\nsecond\x1b"
const BOX = '\x1b[?1049h\x1b[?2004h\x1b[24;24H┃\x1b[25;24H╹\x1b[22;27H\x1b[?25h'
const AGENT_ROW = '\x1b[24;27HBuild\x1b[24;33H·\x1b[24;35HSome Model'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function publicLaunchRig({
  agent = 'opencode2',
  submit = false,
  legacy = false,
  process: inspection = { foregroundProcess: null, hasChildProcesses: false }
}: {
  agent?: TuiAgent
  submit?: boolean
  legacy?: boolean
  process?: TerminalProcessInspection
} = {}) {
  const { runtime } = await createAgentPromptSubmissionRuntime(() => undefined, agent)
  const writes: string[] = []
  const times: number[] = []
  const write = (_id: string, data: string) => {
    writes.push(data)
    times.push(Date.now())
    return true
  }
  const inspectProcess = vi.fn(async () => inspection)
  runtime.setPtyController({
    spawn: async () => ({ id: 'pty-public', incarnationId: 'public-launch' }),
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: () => true,
    getForegroundProcess: async () => inspection.foregroundProcess,
    inspectProcess
  })
  const composer = vi.spyOn(runtime, 'waitForFreshWorkerComposer')
  const fallback = vi.spyOn(runtime, 'waitForAgentLaunchFallback')
  const idle = vi.spyOn(runtime, 'waitForTerminal')
  const context: RpcContext = {
    runtime,
    caller: DESKTOP_RPC_CALLER,
    clientKind: 'runtime',
    clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
  }
  const params = LAUNCH.params.parse({
    agent,
    target: { kind: 'existing', worktree: 'path:/tmp/worktree-a' },
    paneKey: PANE,
    prompt: {
      text: TEXT,
      delivery: submit || legacy ? 'submit' : 'draft',
      transport: legacy
        ? 'paste'
        : { kind: 'desktop-new-tab', promptDelivery: submit ? 'submit-after-ready' : 'draft' }
    }
  })
  return {
    runtime,
    writes,
    times,
    composer,
    fallback,
    idle,
    inspectProcess,
    startedAt: Date.now(),
    start: async () => {
      const pending = LAUNCH.handler(params, context)
      await vi.waitFor(() =>
        expect(composer.mock.calls.length + idle.mock.calls.length).toBeGreaterThan(0)
      )
      return { pending }
    }
  }
}

describe('public desktop launch reuses the upstream host readiness boundary', () => {
  for (const evidence of ['title', 'foreground', 'child'] as const) {
    it(`accepts main's positive ${evidence} fallback with a conservative receipt`, async () => {
      const rig = await publicLaunchRig({
        process: {
          foregroundProcess: evidence === 'foreground' ? 'opencode2' : 'node',
          hasChildProcesses: evidence === 'child'
        }
      })
      const { pending } = await rig.start()
      if (evidence === 'title') {
        rig.runtime.onPtyData('pty-public', '\x1b]0;OpenCode idle\x07', Date.now())
      }
      await vi.runAllTimersAsync()
      expect((await pending).prompt).toMatchObject({
        delivery: 'draft',
        outcome: 'handed-to-terminal',
        composerUnobserved: true
      })
      expect(rig.writes).toEqual([wrapTerminalBracketedPasteText(TEXT)])
      expect(rig.fallback).toHaveBeenCalledOnce()
      expect(rig.idle).not.toHaveBeenCalled()
      expect(rig.times[0] - rig.startedAt).toBeGreaterThanOrEqual(20_000)
      if (evidence === 'child') {
        expect(rig.inspectProcess).toHaveBeenCalledTimes(4)
      }
    })
  }

  it('generic idle alone cannot admit a desktop draft after its composer budget', async () => {
    const rig = await publicLaunchRig()
    rig.idle.mockImplementation(async (handle) => ({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'idle',
      exitCode: null
    }))
    const { pending } = await rig.start()
    await vi.runAllTimersAsync()
    expect((await pending).prompt).toMatchObject({ outcome: 'not-delivered' })
    expect(rig.fallback).toHaveBeenCalledOnce()
    expect(rig.idle).not.toHaveBeenCalled()
    expect(rig.writes).toEqual([])
  })

  it('Codex refuses even positive process fallback when its composer is unseen', async () => {
    const rig = await publicLaunchRig({
      agent: 'codex',
      submit: true,
      process: { foregroundProcess: 'codex', hasChildProcesses: true }
    })
    rig.idle.mockImplementation(async (handle) => ({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'idle',
      exitCode: null
    }))
    const { pending } = await rig.start()
    await vi.runAllTimersAsync()
    expect((await pending).prompt).toMatchObject({ outcome: 'not-delivered' })
    expect(rig.fallback).not.toHaveBeenCalled()
    expect(rig.writes).toEqual([])
  })

  for (const submit of [false, true]) {
    it(`selects the real ${submit ? 'submitted' : 'draft'} scanner and preserves exact writes`, async () => {
      const rig = await publicLaunchRig({ submit })
      const { pending } = await rig.start()
      rig.runtime.onPtyData('pty-public', BOX, Date.now())
      await vi.advanceTimersByTimeAsync(0)
      expect(rig.writes).toEqual(submit ? [] : [wrapTerminalBracketedPasteText(TEXT)])
      if (submit) {
        rig.runtime.onPtyData('pty-public', AGENT_ROW, Date.now())
      }
      await vi.runAllTimersAsync()
      expect((await pending).prompt).toMatchObject({ outcome: 'handed-to-terminal' })
      expect(rig.writes).toEqual([wrapTerminalBracketedPasteText(TEXT), ...(submit ? ['\r'] : [])])
      if (submit) {
        expect(rig.times[1] - rig.times[0]).toBe(50)
      }
      expect(rig.composer.mock.calls[0]?.[3]).toMatchObject({ submit })
      expect(rig.fallback).not.toHaveBeenCalled()
    })
  }

  for (const boundary of ['close', 'generation'] as const) {
    it(`writes zero bytes after ${boundary} changes during readiness`, async () => {
      const rig = await publicLaunchRig({
        process: { foregroundProcess: 'opencode2', hasChildProcesses: false }
      })
      const { pending } = await rig.start()
      const handle = rig.composer.mock.calls[0]![0]
      if (boundary === 'close') {
        await rig.runtime.closeTerminal(handle)
      } else {
        rig.runtime.synchronizePtyOutputSequenceFromProvider(
          'pty-public',
          { value: 0, generation: 'reset' },
          0
        )
      }
      await vi.runAllTimersAsync()
      expect((await pending).prompt).toMatchObject({ outcome: 'not-delivered' })
      expect(rig.writes).toEqual([])
    })
  }

  it('legacy desktop submitted paste still omits scanner selection and uses its existing writer', async () => {
    const rig = await publicLaunchRig({ agent: 'omp', legacy: true })
    rig.composer.mockImplementation(async (handle) => ({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }))
    const { pending } = await rig.start()
    await vi.runAllTimersAsync()
    expect((await pending).prompt).toMatchObject({ outcome: 'handed-to-terminal' })
    expect(rig.composer.mock.calls[0]?.[3]).not.toHaveProperty('submit')
    expect(rig.writes).toEqual([`${wrapTerminalBracketedPasteText(TEXT)}\r`])
    expect(rig.fallback).not.toHaveBeenCalled()
  })
})
