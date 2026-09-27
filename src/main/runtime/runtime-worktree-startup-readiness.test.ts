import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  pasteWorktreeStartupDraftWhenReady,
  sendWorktreeStartupFollowupWhenReady,
  type WorktreeStartupReadinessHost
} from './runtime-worktree-startup-readiness'

function host() {
  const waitForTerminal = vi.fn(async () => ({ satisfied: false, status: 'timeout' }))
  const sendTerminalAgentPrompt = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tests reach only the two runtime methods stubbed here, plus getPtyId and write.
  const readinessHost = {
    waitForTerminal,
    sendTerminalAgentPrompt,
    getPtyId: () => 'pty-1',
    write: vi.fn()
  } as unknown as WorktreeStartupReadinessHost
  return { readinessHost, waitForTerminal }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('worktree-create startup readiness budgets', () => {
  it("waits for a startup draft only within the agent's own draft budget", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const opencode = host()
    pasteWorktreeStartupDraftWhenReady(opencode.readinessHost, 'term_1', {
      agent: 'opencode',
      content: 'draft'
    })
    const goose = host()
    pasteWorktreeStartupDraftWhenReady(goose.readinessHost, 'term_2', {
      agent: 'goose',
      content: 'draft'
    })
    await Promise.resolve()

    // Unsent text pasted long after start could land in the middle of what the user is typing.
    expect(opencode.waitForTerminal).toHaveBeenCalledWith('term_1', {
      condition: 'tui-idle',
      timeoutMs: 20_000,
      acceptComposerReady: true
    })
    expect(goose.waitForTerminal).toHaveBeenCalledWith('term_2', {
      condition: 'tui-idle',
      timeoutMs: 8_000,
      acceptComposerReady: true
    })
  })

  it('gives a startup follow-up the launch budget, as a freshly launched terminal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const goose = host()
    sendWorktreeStartupFollowupWhenReady(goose.readinessHost, 'term_1', { prompt: 'fix it' })
    await Promise.resolve()

    expect(goose.waitForTerminal).toHaveBeenCalledWith('term_1', {
      condition: 'tui-idle',
      timeoutMs: 60_000,
      acceptComposerReady: true
    })
  })
})
