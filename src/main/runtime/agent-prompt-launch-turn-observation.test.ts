import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as HooksSetting from '../../shared/agent-status-hooks-setting'
import type { AgentStatusHooksSettings } from '../../shared/agent-status-hooks-setting'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { AGENT_PROMPT_TEST_WORKTREE_PATH } from './agent-prompt-submission-runtime-test-fixture'
import { resolveAgentPromptObservedProvider } from './agent-prompt-submission-verification'
import { OrcaRuntimeService } from './orca-runtime'
import { dispatchPreambleSendOptions } from './orchestration/preamble'
import { observeWorkerTurnStart } from './rpc/methods/orchestration/worker/worker-start-turn-observation'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

const hooks = vi.hoisted(() => ({ enabled: true }))

vi.mock('../../shared/agent-status-hooks-setting', async (importOriginal) => ({
  ...(await importOriginal<typeof HooksSetting>()),
  isAgentStatusHooksEnabledForAgent: () => hooks.enabled
}))

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/launch-turn-observation',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/launch-turn-observation',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

const RETRY_DELAY_MS = TUI_AGENT_CONFIG.opencode.submitRetryDelayMs ?? 0

type HookRow = { state: 'done' | 'working'; stateStartedAt: number; prompt: string }

/**
 * An OpenCode pane whose status plugin reports through the hook store. `onEnter` runs on each
 * Enter with its ordinal, so a test can post the status OpenCode would.
 */
async function createOpenCodePane(onEnter: (enter: number, hook: HookRow) => void) {
  let handle = ''
  // OpenCode's plugin posts `done` with an empty prompt when it boots.
  const hook: HookRow = { state: 'done', stateStartedAt: Date.now(), prompt: '' }
  const writes: string[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only repos, worktree meta and settings from this store fixture.
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    getAgentStatusSnapshot: () => [
      {
        paneKey: 'prompt-pane',
        terminalHandle: handle,
        state: hook.state,
        prompt: hook.prompt,
        agentType: 'opencode',
        connectionId: null,
        receivedAt: Date.now(),
        stateStartedAt: hook.stateStartedAt
      }
    ]
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-prompt' }),
    write: (_ptyId, data) => {
      writes.push(data)
      if (data === '\r') {
        onEnter(writes.filter((write) => write === '\r').length, hook)
      }
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  handle = (
    await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
      launchAgent: 'opencode'
    })
  ).handle
  const sent = runtime.sendTerminalAgentPrompt(handle, 'Task: reply with OK', {
    ...dispatchPreambleSendOptions('request-1'),
    retrySubmitAfterLaunch: true
  })
  return { runtime, handle, sent, enters: () => writes.filter((data) => data === '\r').length }
}

function postWorkingAfter(delayMs: number, hook: HookRow): void {
  setTimeout(() => {
    hook.state = 'working'
    hook.stateStartedAt = Date.now()
    hook.prompt = 'Task: reply with OK'
  }, delayMs)
}

// Why: OpenCode's plugin posts `working` 59-77 ms after every real submit and nothing for a brief
// stuck in its box, so on a launched worker's first dispatch it both skips the retry Enter and
// makes the receipt honest.
describe('turn observation on a launched OpenCode worker first dispatch', () => {
  afterEach(() => {
    hooks.enabled = true
    vi.useRealTimers()
  })

  it('skips the retry Enter when the first Enter started a turn', async () => {
    vi.useFakeTimers()
    const { sent, enters } = await createOpenCodePane((enter, hook) => {
      if (enter === 1) {
        postWorkingAfter(100, hook)
      }
    })

    await vi.runAllTimersAsync()
    await expect(sent).resolves.toMatchObject({
      prompt: { provider: 'opencode', stages: ['input_accepted', 'turn_started'] }
    })
    expect(enters()).toBe(1)
  })

  it('retries once and reports ready when only the retry Enter starts a turn', async () => {
    vi.useFakeTimers()
    const { runtime, handle, sent, enters } = await createOpenCodePane((enter, hook) => {
      if (enter === 2) {
        postWorkingAfter(100, hook)
      }
    })

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 1_000)
    const receipt = await sent
    expect(enters()).toBe(2)
    expect(receipt.prompt).toMatchObject({ provider: 'opencode', observation: 'supported' })
    const observing = observeWorkerTurnStart({
      runtime,
      terminalHandle: handle,
      prompt: receipt.prompt,
      timeoutMs: 5_000
    })
    await vi.runAllTimersAsync()
    await expect(observing).resolves.toMatchObject({ verdict: 'observed' })
  })

  it('leaves the start unobserved when no Enter starts a turn', async () => {
    vi.useFakeTimers()
    const { runtime, handle, sent, enters } = await createOpenCodePane(() => {})

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 1_000)
    const receipt = await sent
    expect(enters()).toBe(2)
    const observing = observeWorkerTurnStart({
      runtime,
      terminalHandle: handle,
      prompt: receipt.prompt,
      timeoutMs: 5_000
    })
    await vi.runAllTimersAsync()
    await expect(observing).resolves.toMatchObject({ verdict: 'unobserved' })
  })

  it('does not count the boot `done` post as a turn start', async () => {
    vi.useFakeTimers()
    const { sent, enters } = await createOpenCodePane((enter, hook) => {
      if (enter === 1) {
        setTimeout(() => {
          hook.state = 'done'
          hook.stateStartedAt = Date.now()
          hook.prompt = ''
        }, 100)
      }
    })

    await vi.runAllTimersAsync()
    await expect(sent).resolves.toMatchObject({
      prompt: { provider: 'opencode', stages: ['input_accepted'] }
    })
    expect(enters()).toBe(2)
  })

  it('keeps the blind retry and an unsupported receipt with status hooks off', async () => {
    vi.useFakeTimers()
    hooks.enabled = false
    const { runtime, handle, sent, enters } = await createOpenCodePane((enter, hook) => {
      if (enter === 1) {
        postWorkingAfter(100, hook)
      }
    })

    await vi.runAllTimersAsync()
    const receipt = await sent
    expect(enters()).toBe(2)
    expect(receipt.prompt).toMatchObject({ provider: 'unsupported', observation: 'unsupported' })
    await expect(
      observeWorkerTurnStart({ runtime, terminalHandle: handle, prompt: receipt.prompt })
    ).resolves.toMatchObject({ verdict: 'unsupported' })
  })
})

describe('which provider settles a sent prompt', () => {
  const settings: AgentStatusHooksSettings = {}

  it.each([
    ['opencode', true, 'opencode'],
    ['opencode2', true, 'opencode2'],
    ['opencode', false, null],
    ['aider', true, null],
    ['codex', false, 'codex']
  ] as const)('%s, launched-worker first dispatch %s → %s', (agent, launched, provider) => {
    expect(
      resolveAgentPromptObservedProvider({
        foregroundAgent: null,
        launchAgent: agent,
        retrySubmitAfterLaunch: launched,
        settings
      })
    ).toBe(provider)
  })
})
