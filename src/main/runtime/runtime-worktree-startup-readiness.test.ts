import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  pasteWorktreeStartupDraftWhenReady,
  sendWorktreeStartupFollowupWhenReady,
  type WorktreeStartupReadinessHost
} from './runtime-worktree-startup-readiness'

const COMMAND_START = '\x1b]133;C\x07'
const BRACKETED_PASTE_ON = '\x1b[?2004h'

/** `marked`: whether the pane's own shell integration marks its startup command. */
function host(options: { marked: boolean; waitSatisfied?: boolean }) {
  const listeners = new Set<(data: string) => void>()
  const write = vi.fn()
  const waitForTerminal = vi.fn(async () => ({
    satisfied: options.waitSatisfied ?? true,
    status: 'ready'
  }))
  const sendTerminalAgentPrompt = vi.fn(async () => ({ accepted: true }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tests reach only the members stubbed here.
  const readinessHost = {
    waitForTerminal,
    sendTerminalAgentPrompt,
    getPtyId: () => 'pty-1',
    startupCommandMarked: () => options.marked,
    getForegroundProcess: async () => 'goose',
    subscribeToData: (_ptyId: string, listener: (data: string) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    readRecentOutput: () => undefined,
    write
  } as unknown as WorktreeStartupReadinessHost
  const emit = (data: string): void => {
    for (const listener of listeners) {
      listener(data)
    }
  }
  return { readinessHost, emit, write, waitForTerminal, sendTerminalAgentPrompt, listeners }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('worktree-create startup draft', () => {
  it.each([
    // The pane's output carries marks, as a user's own shell integration would write them.
    ['goose', 'a pane whose shell integration does not mark commands', false],
    ['aider', 'an undeclared agent in a marking pane', true]
  ] as const)(
    'pastes %s after the 1.5 s quiet window for %s, exactly as before',
    async (agent, _case, marked) => {
      const h = host({ marked })
      pasteWorktreeStartupDraftWhenReady(h.readinessHost, 'term_1', { agent, content: 'draft' })
      h.emit(`${COMMAND_START}${BRACKETED_PASTE_ON}`)
      await vi.advanceTimersByTimeAsync(1_499)
      expect(h.write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      expect(h.write).toHaveBeenCalledWith('pty-1', '\x1b[200~draft\x1b[201~')
      expect(h.waitForTerminal).not.toHaveBeenCalled()
      expect(h.listeners.size).toBe(0)
    }
  )

  it.each([
    // Why these budgets: the per-agent draft budget, plus tui-idle's 3 s quiet and 2 s poll, less
    // the base's 1.5 s quiet.
    ['goose', 11_500],
    ['opencode', 23_500]
  ] as const)(
    'hands a declared %s in a marking pane to the launch wait before any output arrives',
    async (agent: TuiAgent, timeoutMs) => {
      const h = host({ marked: true })
      pasteWorktreeStartupDraftWhenReady(h.readinessHost, 'term_1', { agent, content: 'draft' })
      await vi.advanceTimersByTimeAsync(0)

      expect(h.waitForTerminal).toHaveBeenCalledWith('term_1', {
        condition: 'tui-idle',
        timeoutMs,
        acceptComposerReady: true
      })
      expect(h.listeners.size).toBe(0)
      expect(h.write).toHaveBeenCalledTimes(1)
      expect(h.write).toHaveBeenCalledWith('pty-1', '\x1b[200~draft\x1b[201~')
    }
  )

  it('drops the draft when the launch wait does not settle ready', async () => {
    const h = host({ marked: true, waitSatisfied: false })
    pasteWorktreeStartupDraftWhenReady(h.readinessHost, 'term_1', {
      agent: 'goose',
      content: 'draft'
    })
    h.emit(BRACKETED_PASTE_ON)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(h.waitForTerminal).toHaveBeenCalled()
    expect(h.write).not.toHaveBeenCalled()
  })
})

describe('worktree-create startup follow-up', () => {
  it.each([
    ['goose', 'a pane whose shell integration does not mark commands', false],
    ['aider', 'an undeclared agent in a marking pane', true]
  ] as const)(
    'types %s its prompt on the process match for %s, exactly as before',
    async (agent, _case, marked) => {
      const h = host({ marked })
      sendWorktreeStartupFollowupWhenReady(h.readinessHost, 'term_1', {
        agent,
        expectedProcess: 'goose',
        prompt: 'fix it'
      })
      h.emit(`${COMMAND_START}banner`)
      await vi.advanceTimersByTimeAsync(0)

      expect(h.write).toHaveBeenCalledWith('pty-1', 'fix it\r')
      expect(h.waitForTerminal).not.toHaveBeenCalled()
      expect(h.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    }
  )

  it('hands a declared agent in a marking pane to the launch deliverer, whatever has arrived', async () => {
    const h = host({ marked: true })
    sendWorktreeStartupFollowupWhenReady(h.readinessHost, 'term_1', {
      agent: 'goose',
      expectedProcess: 'goose',
      prompt: 'line one\nline two'
    })
    // The OS already reports goose in the foreground, and no mark has reached the runtime.
    await vi.advanceTimersByTimeAsync(4_500)

    expect(h.waitForTerminal).toHaveBeenCalledWith('term_1', {
      condition: 'tui-idle',
      timeoutMs: 60_000,
      acceptComposerReady: true
    })
    expect(h.sendTerminalAgentPrompt).toHaveBeenCalledTimes(1)
    expect(h.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_1',
      'line one\nline two',
      expect.anything()
    )
    expect(h.write).not.toHaveBeenCalled()
  })
})
