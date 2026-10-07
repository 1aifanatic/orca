import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import { deliverTerminalAgentLaunchPrompt } from './rpc/methods/agent-launch-terminal-prompt'

vi.mock('../git/worktree', () => ({
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
// The existing OpenCode 2.0.21 capture shape in runtime-worktree-startup-readiness.test.ts.
const BOX = '\x1b[?1049h\x1b[?2004h\x1b[24;24H┃\x1b[25;24H╹\x1b[22;27H\x1b[?25h'
const AGENT_ROW = '\x1b[24;27HBuild\x1b[24;33H·\x1b[24;35HSome Model'
const DESKTOP_DRAFT = {
  text: 'draft',
  delivery: 'draft',
  transport: { kind: 'desktop-new-tab', promptDelivery: 'draft' }
} as const

describe('desktop readiness selects draft through the existing public scanner', () => {
  afterEach(() => vi.useRealTimers())
  it('an explicit draft uses the box cursor without waiting for submitted readiness', async () => {
    vi.useFakeTimers()
    const { runtime, handle } = await createAgentPromptSubmissionRuntime(
      () => undefined,
      'opencode2'
    )
    const stop = new AbortController()
    let settled = false
    const wait = runtime
      .waitForFreshWorkerComposer(handle, 'opencode2', 20_000, {
        requireComposerMarker: false,
        submit: false,
        signal: stop.signal
      })
      .then((result) => {
        settled = true
        return result
      })
      .catch(() => null)
    try {
      runtime.onPtyData('pty-prompt', BOX, Date.now())
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(true)
      await expect(wait).resolves.toMatchObject({ satisfied: true })
    } finally {
      stop.abort()
    }
  })
  it('an old caller still defaults to submitted readiness and waits for the agent row', async () => {
    vi.useFakeTimers()
    const { runtime, handle } = await createAgentPromptSubmissionRuntime(
      () => undefined,
      'opencode2'
    )
    let settled = false
    const wait = runtime
      .waitForFreshWorkerComposer(handle, 'opencode2', 20_000, { requireComposerMarker: false })
      .then((result) => {
        settled = true
        return result
      })
    runtime.onPtyData('pty-prompt', BOX, Date.now())
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toBe(false)
    runtime.onPtyData('pty-prompt', AGENT_ROW, Date.now())
    await vi.advanceTimersByTimeAsync(0)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
  })
  it('desktop draft selection reaches the public method with its configured budget', async () => {
    const { runtime, handle } = await createAgentPromptSubmissionRuntime(() => undefined)
    const ready = vi.spyOn(runtime, 'waitForFreshWorkerComposer').mockResolvedValue({
      handle,
      condition: 'tui-idle',
      status: 'running',
      satisfied: true,
      exitCode: null
    })
    expect(
      await deliverTerminalAgentLaunchPrompt({
        runtime,
        handle,
        agent: 'opencode',
        freshLaunch: true,
        text: 'draft',
        prompt: DESKTOP_DRAFT,
        callerKey: 'trusted-local:desktop'
      })
    ).toBe(true)
    expect(ready).toHaveBeenCalledWith(handle, 'opencode', 20_000, {
      requireComposerMarker: true,
      stopOnDialog: true,
      submit: false
    })
  })
  it('a stale readiness handle never takes the timeout fallback or writes', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    const fallback = vi.spyOn(runtime, 'waitForAgentLaunchFallback')
    vi.spyOn(runtime, 'waitForFreshWorkerComposer').mockRejectedValue(
      new Error('terminal_handle_stale')
    )
    vi.spyOn(runtime, 'waitForTerminal').mockRejectedValue(new Error('terminal_handle_stale'))
    expect(
      await deliverTerminalAgentLaunchPrompt({
        runtime,
        handle,
        agent: 'opencode',
        freshLaunch: true,
        text: 'draft',
        prompt: DESKTOP_DRAFT,
        callerKey: 'trusted-local:desktop'
      })
    ).toBe(false)
    expect(fallback).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })
  it('Codex does not fall back on its timeout', async () => {
    const { runtime, handle } = await createAgentPromptSubmissionRuntime(() => undefined)
    const fallback = vi.spyOn(runtime, 'waitForAgentLaunchFallback')
    vi.spyOn(runtime, 'waitForFreshWorkerComposer').mockRejectedValue(new Error('timeout'))
    expect(
      await deliverTerminalAgentLaunchPrompt({
        runtime,
        handle,
        agent: 'codex',
        freshLaunch: true,
        text: 'draft',
        prompt: DESKTOP_DRAFT,
        callerKey: 'trusted-local:desktop'
      })
    ).toBe(false)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('generic idle satisfaction alone cannot replace positive desktop fallback evidence', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    vi.spyOn(runtime, 'waitForFreshWorkerComposer').mockRejectedValue(new Error('timeout'))
    const idle = vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle,
      condition: 'tui-idle',
      status: 'running',
      satisfied: true,
      exitCode: null
    })
    const fallback = vi.spyOn(runtime, 'waitForAgentLaunchFallback').mockResolvedValue({
      ready: false,
      reason: 'timeout'
    })
    expect(
      await deliverTerminalAgentLaunchPrompt({
        runtime,
        handle,
        agent: 'opencode',
        freshLaunch: true,
        text: 'draft',
        prompt: DESKTOP_DRAFT,
        callerKey: 'trusted-local:desktop'
      })
    ).toBe(false)
    expect(fallback).toHaveBeenCalledWith(handle, 'opencode')
    expect(idle).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('accepted timeout fallback reports unconfirmed before the first desktop byte', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {
      events.push('write')
    }, 'claude')
    vi.spyOn(runtime, 'waitForFreshWorkerComposer').mockRejectedValue(new Error('timeout'))
    vi.spyOn(runtime, 'waitForAgentLaunchFallback').mockResolvedValue({
      ready: true,
      reason: 'foreground-match'
    })
    const pending = deliverTerminalAgentLaunchPrompt({
      runtime,
      handle,
      agent: 'claude',
      freshLaunch: true,
      text: 'draft',
      callerKey: 'trusted-local:desktop',
      prompt: {
        text: 'draft',
        delivery: 'draft',
        transport: { kind: 'desktop-new-tab', promptDelivery: 'draft' }
      },
      onComposerUnobserved: () => {
        expect(writes).toEqual([])
        events.push('unconfirmed')
      }
    })
    await vi.runAllTimersAsync()
    expect(await pending).toBe(true)
    expect(events).toEqual(['unconfirmed', 'write'])
  })
})
