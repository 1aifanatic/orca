import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import { GROK_STARTUP_PTY_TRACE } from '../../shared/__fixtures__/grok-startup-pty-trace'
import type { GrokStartupTraceChunk } from '../../shared/__fixtures__/grok-startup-pty-trace'
import { GROK_INLINE_STARTUP_PTY_TRACE } from '../../shared/__fixtures__/grok-inline-startup-pty-trace'
import {
  waitForLaunchedAgentComposer,
  type LaunchedAgentReadinessRuntime
} from './launched-agent-composer-readiness'
import { waitForWorktreeStartupDraft } from './runtime-worktree-startup-readiness'

/** The runtime's composer wait over a replayed PTY stream, with its defaults. */
function replayRuntime() {
  let listener = (_data: string): void => {}
  const waitForFreshWorkerComposer = vi.fn(
    async (
      handle: string,
      agent: TuiAgent,
      timeoutMs: number,
      {
        requireComposerMarker = true,
        signal
      }: { requireComposerMarker?: boolean; signal?: AbortSignal } = {}
    ): Promise<void> => {
      const ptyId = await waitForWorktreeStartupDraft(
        {
          getPtyId: () => 'pty-1',
          getForegroundProcess: async () => agent,
          subscribeToData: (_ptyId, onData) => {
            listener = onData
            return () => {
              listener = () => {}
            }
          },
          readRecentOutput: () => undefined,
          write: vi.fn()
        },
        handle,
        agent,
        { timeoutMs, requireComposerMarker, signal }
      )
      if (!ptyId) {
        throw new Error('timeout')
      }
    }
  )
  /** The `tui-idle` floor: pending until a test settles it, and it records its stop signal. */
  let idleSignal: AbortSignal | undefined
  let settleIdle = (_wait: RuntimeTerminalWait): void => {}
  const waitForTerminal = vi.fn(
    (_handle: string, options?: { signal?: AbortSignal }): Promise<RuntimeTerminalWait> => {
      idleSignal = options?.signal
      return new Promise((resolve, reject) => {
        settleIdle = resolve
        options?.signal?.addEventListener('abort', () => reject(new Error('request_aborted')))
      })
    }
  )
  const runtime: LaunchedAgentReadinessRuntime = {
    waitForTerminal,
    waitForFreshWorkerComposer
  }
  const play = async (trace: GrokStartupTraceChunk[]): Promise<void> => {
    let now = 0
    for (const chunk of trace) {
      await vi.advanceTimersByTimeAsync(chunk.t - now)
      now = chunk.t
      listener(chunk.data ?? 'x'.repeat(chunk.bytes ?? 0))
    }
  }
  return {
    runtime,
    play,
    feed: (data: string) => listener(data),
    idleStopped: () => idleSignal?.aborted === true,
    settleIdle: (wait: RuntimeTerminalWait) => settleIdle(wait)
  }
}

describe('launched grok composer readiness', () => {
  afterEach(() => vi.useRealTimers())

  it('opens on the composer frame in the default full-screen mode', async () => {
    vi.useFakeTimers()
    const h = replayRuntime()
    const ready = waitForLaunchedAgentComposer(h.runtime, 'term-1', 'grok', 60_000)
    await h.play(GROK_STARTUP_PTY_TRACE)
    await expect(ready).resolves.toBeUndefined()
  })

  it('still opens in inline mode, which never switches to the alternate screen', async () => {
    // `grok --no-alt-screen` / `screen_mode = "minimal"` paints its `❯` without the anchor the
    // marker needs, so the quiet window after bracketed paste is its only readiness.
    vi.useFakeTimers()
    const h = replayRuntime()
    const ready = waitForLaunchedAgentComposer(h.runtime, 'term-1', 'grok', 60_000)
    const settled = vi.fn()
    void ready.then(settled, settled)
    await h.play(GROK_INLINE_STARTUP_PTY_TRACE)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(settled).toHaveBeenCalledWith(undefined)
  })

  it('keeps ZCode on its composer marker alone', async () => {
    vi.useFakeTimers()
    const h = replayRuntime()
    const ready = waitForLaunchedAgentComposer(h.runtime, 'term-1', 'zcode', 1_000)
    void ready.catch(() => {})
    expect(h.runtime.waitForFreshWorkerComposer).toHaveBeenCalledWith('term-1', 'zcode', 1_000, {
      requireComposerMarker: true
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(ready).rejects.toThrow('timeout')
  })
})

describe('launched composer readiness for agents the idle evidence can also read', () => {
  afterEach(() => vi.useRealTimers())

  const IDLE_READY: RuntimeTerminalWait = {
    handle: 'term-1',
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  }

  it('pastes on the quiet window after bracketed paste, as the desktop did, and stops the idle wait', async () => {
    vi.useFakeTimers()
    const h = replayRuntime()
    const ready = waitForLaunchedAgentComposer(h.runtime, 'term-1', 'claude', 60_000)
    const settled = vi.fn()
    void ready.then(settled, settled)
    h.feed('\x1b[?2004h\x1b[?25l welcome to claude code \x1b[?25h')

    await vi.advanceTimersByTimeAsync(1_400)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(settled).toHaveBeenCalledWith(undefined)
    expect(h.idleStopped()).toBe(true)
  })

  it('settles on the idle evidence where bracketed paste never arrives, as under Windows ConPTY', async () => {
    vi.useFakeTimers()
    const h = replayRuntime()
    const ready = waitForLaunchedAgentComposer(h.runtime, 'term-1', 'claude', 60_000)
    h.feed('\x1b[?25l welcome to claude code \x1b[?25h')
    await vi.advanceTimersByTimeAsync(10_000)

    h.settleIdle(IDLE_READY)

    await expect(ready).resolves.toEqual(IDLE_READY)
  })
})
