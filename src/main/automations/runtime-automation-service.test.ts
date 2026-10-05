import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'

const captured = vi.hoisted((): { dispatcher: unknown } => ({ dispatcher: null }))

vi.mock('./service', () => ({
  AutomationService: class {
    constructor(_store: unknown, opts: { headlessDispatcher?: unknown }) {
      captured.dispatcher = opts.headlessDispatcher
    }
  }
}))

import { createRuntimeAutomationService } from './runtime-automation-service'
import { HEADLESS_AGENT_START_DEADLINE_MS } from './headless-run-completion'

const PANE_KEY = 'tab-1:pane-1'

function headlessRuntime(rows: () => { receivedAt: number }[]) {
  return {
    setAutomationService: vi.fn(),
    notifyAutomationsChanged: vi.fn(),
    launchAgentTerminal: vi.fn(async () => ({
      handle: 'terminal-1',
      tabId: 'tab-1',
      paneKey: PANE_KEY,
      ptyId: 'pty-1',
      worktreeId: 'wt-1'
    })),
    showManagedWorktree: vi.fn(async () => ({ displayName: 'repo' })),
    // A ready shell prompt satisfies tui-idle whether or not an agent ever ran.
    waitForTerminal: vi.fn(async () => ({ satisfied: true })),
    readTerminal: vi.fn(async () => ({
      tail: ['$ goose run', 'bash: goose: command not found', '$']
    })),
    getAgentStatusRowsForPane: vi.fn(rows)
  }
}

function dispatch(runtime: ReturnType<typeof headlessRuntime>) {
  createRuntimeAutomationService({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked service never reads the store.
    store: {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only the members faked above.
    runtime: runtime as never,
    headless: true
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: captured from the mocked constructor above.
  const dispatcher = captured.dispatcher as HeadlessAutomationDispatcher
  return dispatchOnce(dispatcher)
}

async function dispatchOnce(dispatcher: HeadlessAutomationDispatcher) {
  const launch = await dispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a reuse-workspace automation; only these fields are read.
    automation: {
      workspaceMode: 'existing',
      workspaceId: 'wt-1',
      agentId: 'goose',
      prompt: 'hi'
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the title is read.
    run: { title: 'Nightly' } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unused for an existing workspace.
    target: {} as never
  })
  if (!launch.completion) {
    throw new Error('a headless dispatch always reports its completion')
  }
  return { ...launch, completion: launch.completion }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('headless automation run completion', () => {
  it('never completes a run whose agent is not installed', async () => {
    vi.useFakeTimers()
    const runtime = headlessRuntime(() => [])
    const result = await dispatch(runtime)
    const settled = vi.fn()
    void result.completion.then(settled)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(HEADLESS_AGENT_START_DEADLINE_MS)
    const observation = await result.completion
    expect(observation.status).toBe('dispatch_failed')
    expect(observation.error).toContain('never reported starting')
  })

  it('completes once the agent itself reported for the run pane after dispatch', async () => {
    const runtime = headlessRuntime(() => [{ receivedAt: Date.now() }])
    const result = await dispatch(runtime)
    await expect(result.completion).resolves.toMatchObject({ status: 'completed', error: null })
    expect(runtime.getAgentStatusRowsForPane).toHaveBeenCalledWith(PANE_KEY)
  })

  it('does not count agent status the pane held from before this dispatch', async () => {
    vi.useFakeTimers()
    const runtime = headlessRuntime(() => [{ receivedAt: 1 }])
    const result = await dispatch(runtime)
    await vi.advanceTimersByTimeAsync(HEADLESS_AGENT_START_DEADLINE_MS + 1_000)
    await expect(result.completion).resolves.toMatchObject({ status: 'dispatch_failed' })
  })

  it('waits for an agent that reports after the shell first looked idle', async () => {
    vi.useFakeTimers()
    let rows: { receivedAt: number }[] = []
    const runtime = headlessRuntime(() => rows)
    const result = await dispatch(runtime)
    await vi.advanceTimersByTimeAsync(5_000)
    rows = [{ receivedAt: Date.now() }]
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(result.completion).resolves.toMatchObject({ status: 'completed' })
  })
})
