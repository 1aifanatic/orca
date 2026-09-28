import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  pasteWorktreeStartupDraftWhenReady,
  sendWorktreeStartupFollowupWhenReady,
  type WorktreeStartupReadinessHost
} from './runtime-worktree-startup-readiness'

const COMMAND_START = '\x1b]133;C\x07'
const PROMPT_START = '\x1b]133;A\x07'
const BRACKETED_PASTE_ON = '\x1b[?2004h'

function host(waitSatisfied = true) {
  const listeners = new Set<(data: string) => void>()
  const write = vi.fn()
  const waitForTerminal = vi.fn(async () => ({ satisfied: waitSatisfied, status: 'ready' }))
  const sendTerminalAgentPrompt = vi.fn(async () => ({ accepted: true }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tests reach only the members stubbed here.
  const readinessHost = {
    waitForTerminal,
    sendTerminalAgentPrompt,
    getPtyId: () => 'pty-1',
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
    ['goose', 'no command-start mark', BRACKETED_PASTE_ON],
    ['aider', 'an undeclared agent', `${COMMAND_START}${BRACKETED_PASTE_ON}`]
  ] as const)(
    'pastes %s after the 1.5 s quiet window on %s, exactly as before',
    async (agent, _case, output) => {
      const h = host()
      pasteWorktreeStartupDraftWhenReady(h.readinessHost, 'term_1', { agent, content: 'draft' })
      h.emit(output)
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
    // the base's 1.5 s quiet, less the time the base took to fire.
    ['goose', BRACKETED_PASTE_ON, 1_500, 11_500 - 1_500],
    ['opencode', `${BRACKETED_PASTE_ON}\x1b[?25h`, 0, 23_500]
  ] as const)(
    'hands a declared %s with a command-start mark to the launch-readiness wait',
    async (agent: TuiAgent, output, baseFiresAfterMs, timeoutMs) => {
      const h = host()
      pasteWorktreeStartupDraftWhenReady(h.readinessHost, 'term_1', { agent, content: 'draft' })
      h.emit(`${COMMAND_START}${output}`)
      await vi.advanceTimersByTimeAsync(baseFiresAfterMs)

      expect(h.waitForTerminal).toHaveBeenCalledWith('term_1', {
        condition: 'tui-idle',
        timeoutMs,
        acceptComposerReady: true
      })
      expect(h.write).toHaveBeenCalledTimes(1)
      expect(h.write).toHaveBeenCalledWith('pty-1', '\x1b[200~draft\x1b[201~')
    }
  )

  it("pastes as before at the draft budget when a marking shell never marks the agent's start", async () => {
    const h = host()
    pasteWorktreeStartupDraftWhenReady(h.readinessHost, 'term_1', {
      agent: 'goose',
      content: 'draft'
    })
    h.emit(`${PROMPT_START}$ ${BRACKETED_PASTE_ON}`)
    await vi.advanceTimersByTimeAsync(7_999)
    expect(h.write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(h.write).toHaveBeenCalledWith('pty-1', '\x1b[200~draft\x1b[201~')
    expect(h.waitForTerminal).not.toHaveBeenCalled()
  })

  it('drops the draft when the launch-readiness wait does not settle ready', async () => {
    const h = host(false)
    pasteWorktreeStartupDraftWhenReady(h.readinessHost, 'term_1', {
      agent: 'goose',
      content: 'draft'
    })
    h.emit(`${COMMAND_START}${BRACKETED_PASTE_ON}`)
    await vi.advanceTimersByTimeAsync(1_500)

    expect(h.waitForTerminal).toHaveBeenCalled()
    expect(h.write).not.toHaveBeenCalled()
  })
})

describe('worktree-create startup follow-up', () => {
  it.each([
    ['goose', 'no command-start mark', 'goose banner'],
    ['aider', 'an undeclared agent', `${COMMAND_START}aider banner`]
  ] as const)(
    'types %s its prompt on the process match on %s, exactly as before',
    async (agent, _case, output) => {
      const h = host()
      sendWorktreeStartupFollowupWhenReady(h.readinessHost, 'term_1', {
        agent,
        expectedProcess: 'goose',
        prompt: 'fix it'
      })
      h.emit(output)
      await vi.advanceTimersByTimeAsync(0)

      expect(h.write).toHaveBeenCalledWith('pty-1', 'fix it\r')
      expect(h.waitForTerminal).not.toHaveBeenCalled()
      expect(h.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    }
  )

  it('hands a declared agent with a command-start mark to the launch deliverer', async () => {
    const h = host()
    sendWorktreeStartupFollowupWhenReady(h.readinessHost, 'term_1', {
      agent: 'goose',
      expectedProcess: 'goose',
      prompt: 'fix it'
    })
    h.emit(`${COMMAND_START}goose banner`)
    await vi.advanceTimersByTimeAsync(0)

    expect(h.waitForTerminal).toHaveBeenCalledWith('term_1', {
      condition: 'tui-idle',
      timeoutMs: 60_000,
      acceptComposerReady: true
    })
    expect(h.sendTerminalAgentPrompt).toHaveBeenCalledWith('term_1', 'fix it', expect.anything())
    expect(h.write).not.toHaveBeenCalled()
  })

  it("hands a marking shell's agent to the deliverer once its late command-start mark arrives", async () => {
    const h = host()
    sendWorktreeStartupFollowupWhenReady(h.readinessHost, 'term_1', {
      agent: 'goose',
      expectedProcess: 'goose',
      prompt: 'line one\nline two'
    })
    h.emit(`${PROMPT_START}$ `)
    await vi.advanceTimersByTimeAsync(400)
    expect(h.write).not.toHaveBeenCalled()

    h.emit(`${COMMAND_START}goose banner`)
    await vi.advanceTimersByTimeAsync(0)

    expect(h.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_1',
      'line one\nline two',
      expect.anything()
    )
    expect(h.write).not.toHaveBeenCalled()
  })

  it("types as before at the poll budget when a marking shell never marks the agent's start", async () => {
    const h = host()
    sendWorktreeStartupFollowupWhenReady(h.readinessHost, 'term_1', {
      agent: 'goose',
      expectedProcess: 'goose',
      prompt: 'fix it'
    })
    h.emit(`${PROMPT_START}$ `)
    await vi.advanceTimersByTimeAsync(4_499)
    expect(h.write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(h.write).toHaveBeenCalledWith('pty-1', 'fix it\r')
    expect(h.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(h.listeners.size).toBe(0)
  })
})
