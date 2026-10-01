import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import type { TerminalSideEffectBatch } from '../../../shared/terminal-side-effect-facts'

const dispatchTerminalNotification = vi.fn()
const dispatchAgentHookTerminalLifecycle = vi.fn()

let mockStoreState: {
  settings: { notifications: { enabled: boolean; agentTaskComplete: boolean } }
  ptyIdsByTabId: Record<string, string[]>
  suppressedPtyExitIds: Record<string, boolean>
  tabsByWorktree: Record<string, { id: string; ptyId?: string | null }[]>
  terminalLayoutsByTabId: Record<string, never>
  agentStatusByPaneKey: Record<string, never>
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState }
}))

vi.mock('@/components/terminal-pane/use-notification-dispatch', () => ({
  dispatchTerminalNotification
}))

vi.mock('@/components/terminal-pane/agent-hook-terminal-lifecycle', () => ({
  dispatchAgentHookTerminalLifecycle
}))

const HOOK_DONE_QUIET_MS = 1_500
const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function hookStatus(
  state: ParsedAgentStatusPayload['state'],
  agentType: string
): ParsedAgentStatusPayload {
  return { state, prompt: 'fix the bug', agentType }
}

function endedRunBatch(
  agentType: string,
  options: { interrupted?: true; replay?: true } = {}
): TerminalSideEffectBatch {
  return {
    ptyId: 'pty-1',
    seq: 1,
    paneKey: PANE_KEY,
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    ...(options.replay ? { replay: true } : {}),
    facts: [
      {
        kind: 'agent-run-ended',
        agentType,
        ...(options.interrupted ? { interrupted: true } : {})
      },
      { kind: 'command-finished', exitCode: options.interrupted ? 130 : 0 }
    ]
  }
}

async function load() {
  const notifications = await import('./agent-hook-completion-notifications')
  const facts = await import('@/components/terminal-pane/terminal-side-effect-facts-handler')
  const observe = (payload: ParsedAgentStatusPayload): void =>
    notifications.observeAgentHookCompletionForNotification({
      paneKey: PANE_KEY,
      worktreeId: 'wt-1',
      payload
    })
  return { observe, dispatch: facts._dispatchTerminalSideEffectBatchForTest }
}

// Why: `opencode run` posts no Done (its process exit clears the row), so its end reaches the
// renderer only as a side-effect fact; it must notify like a hook Done, with no consumer bound.
describe('ended agent run notifications', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalNotification.mockClear()
    dispatchAgentHookTerminalLifecycle.mockClear()
    mockStoreState = {
      settings: { notifications: { enabled: true, agentTaskComplete: true } },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      suppressedPtyExitIds: {},
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' }] },
      terminalLayoutsByTabId: {},
      agentStatusByPaneKey: {}
    }
  })

  afterEach(() => vi.useRealTimers())

  it('announces a finished run in a pane with no fact consumer, after the quiet window', async () => {
    const { observe, dispatch } = await load()
    observe(hookStatus('working', 'opencode2'))

    dispatch(endedRunBatch('opencode2'))
    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey: PANE_KEY,
        agentStatusSnapshot: expect.objectContaining({ state: 'done', agentType: 'opencode2' })
      })
    )
  })

  it('reads a Ctrl+C exit as an interrupted turn', async () => {
    const { observe, dispatch } = await load()
    observe(hookStatus('working', 'opencode2'))

    dispatch(endedRunBatch('opencode2', { interrupted: true }))
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        agentStatusSnapshot: expect.objectContaining({ state: 'done', interrupted: true })
      })
    )
  })

  it('announces nothing for a pane that never showed the run working', async () => {
    const { dispatch } = await load()

    dispatch(endedRunBatch('opencode2'))
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
  })

  it('never announces from a replayed batch', async () => {
    const { observe, dispatch } = await load()
    observe(hookStatus('working', 'opencode2'))

    dispatch(endedRunBatch('opencode2', { replay: true }))
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
  })

  // OpenCode 1 `run` loads its plugin, whose own Done announces the turn before the process exits.
  it('adds nothing when the plugin Done already announced the run', async () => {
    const { observe, dispatch } = await load()
    observe(hookStatus('working', 'opencode'))
    observe(hookStatus('done', 'opencode'))
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)

    dispatch(endedRunBatch('opencode'))
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
  })

  it('announces once when the run exits inside the plugin Done’s quiet window', async () => {
    const { observe, dispatch } = await load()
    observe(hookStatus('working', 'opencode'))
    observe(hookStatus('done', 'opencode'))
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS / 2)

    dispatch(endedRunBatch('opencode'))
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS * 2)

    expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
  })

  it('lets a new turn in the pane cancel the pending announcement', async () => {
    const { observe, dispatch } = await load()
    observe(hookStatus('working', 'opencode2'))

    dispatch(endedRunBatch('opencode2'))
    observe(hookStatus('working', 'opencode2'))
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchTerminalNotification).not.toHaveBeenCalled()
  })
})
