import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  OrcaRuntimeService,
  acknowledgeAgentPromptSubmit
} from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_PATH, store } from '../orca-runtime-test-fixtures.spec'

// A launch's first prompt goes in right after the caller saw the agent's composer accept input, as
// the desktop's own draft paste did: Enter one turn after the paste, not after the render settles.
async function launchedAgentPane(agent: 'claude' | 'codex' | 'qwen-code') {
  const writes: { data: string; at: number }[] = []
  const runtime = new OrcaRuntimeService(store)
  const startedAt = Date.now()
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
    write: (_ptyId, data) => {
      writes.push({ data, at: Date.now() - startedAt })
      if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
        // A live Claude keeps repainting after a paste, so its render never settles.
        runtime.onPtyData('pty-bg', '\x1b[?25h', Date.now())
        for (let delay = 500; delay <= 9_000; delay += 500) {
          setTimeout(() => runtime.onPtyData('pty-bg', `frame ${delay}`, Date.now()), delay)
        }
      }
      acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
    launchAgent: agent
  })
  return { runtime, handle, writes }
}

describe('a launch prompt into a composer the caller saw ready', () => {
  it('submits one turn after the paste instead of waiting out the render cap', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, writes } = await launchedAgentPane('claude')

      const send = runtime.sendTerminalAgentPrompt(handle, 'fix the checks\nlog tail', {
        inputKind: 'launch',
        composerReady: true
      })
      await vi.advanceTimersByTimeAsync(49)
      expect(writes.map((write) => write.data)).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(2)
      await send
      // One Enter: Claude takes no second one.
      expect(writes.filter((write) => write.data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['codex', 'qwen-code'] as const)(
    'sends %s its second Enter after its retry delay, as the desktop paste did',
    async (agent) => {
      vi.useFakeTimers()
      try {
        const { runtime, handle, writes } = await launchedAgentPane(agent)

        const send = runtime.sendTerminalAgentPrompt(handle, 'explain this commit', {
          inputKind: 'launch',
          composerReady: true
        })
        await vi.advanceTimersByTimeAsync(51)
        expect(writes.filter((write) => write.data === '\r')).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1_200)
        await send
        expect(writes.filter((write) => write.data === '\r')).toHaveLength(2)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('keeps a prompt into a running agent behind the render settle, as before', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, writes } = await launchedAgentPane('claude')

      const send = runtime.sendTerminalAgentPrompt(handle, 'fix the checks', {
        inputKind: 'driving'
      })
      await vi.advanceTimersByTimeAsync(7_000)
      expect(writes.map((write) => write.data)).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(2_000)
      await send
      expect(writes.filter((write) => write.data === '\r')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
