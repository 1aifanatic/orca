/**
 * What the host may claim about a prompt it wrote into somebody's PTY.
 *
 * The receipt has no "maybe" arm, so each case below has to resolve to delivered or not, and the
 * two failure shapes pull in opposite directions: a composer that never opened means the text is
 * definitely absent, while a stalled submission means it is definitely present and merely
 * unobserved. Getting the second one wrong duplicates a turn instead of dropping one.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { deliverTerminalAgentLaunchPrompt } from './agent-launch-terminal-prompt'
import { AGENT_PROMPT_STALLED_ERROR } from '../../agent-prompt-submission-verification'

type SendResult = { handle: string; accepted: boolean; bytesWritten: number }
type SendFn = (
  handle: string,
  text: string,
  options: Record<string, unknown>
) => Promise<SendResult>

/** Until aborted, as a wait that has seen nothing settles. */
function pendingUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('request_aborted')))
  })
}

function runtimeStub(overrides: {
  wait?: unknown
  waits?: unknown[]
  send?: SendFn
  /** Whether the agent's composer signal fires; the idle evidence alone decides otherwise. */
  composerSignal?: boolean
  idlePending?: boolean
}) {
  const queued = [...(overrides.waits ?? [])]
  const waitForTerminal = vi.fn(
    async (
      _handle: string,
      options?: { condition?: string; timeoutMs?: number; signal?: AbortSignal }
    ) =>
      overrides.idlePending
        ? pendingUntilAborted(options?.signal)
        : (queued.shift() ?? overrides.wait ?? { satisfied: true, status: 'idle' })
  )
  const waitForFreshWorkerComposer = vi.fn(
    async (
      _handle: string,
      _agent: string,
      _timeoutMs: number,
      options?: { signal?: AbortSignal }
    ): Promise<void> =>
      overrides.composerSignal ? undefined : pendingUntilAborted(options?.signal)
  )
  const sendTerminalAgentPrompt = vi.fn<SendFn>(
    overrides.send ?? (async () => ({ handle: 'term_1', accepted: true, bytesWritten: 12 }))
  )
  return {
    waitForTerminal,
    waitForFreshWorkerComposer,
    sendTerminalAgentPrompt,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deliverer reaches exactly these three runtime methods; anything else would throw rather than read a wrong value.
    runtime: {
      waitForTerminal,
      waitForFreshWorkerComposer,
      sendTerminalAgentPrompt
    } as unknown as Parameters<typeof deliverTerminalAgentLaunchPrompt>[0]['runtime']
  }
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
})

describe('writing a launch prompt into a terminal agent', () => {
  it('waits for the composer before writing, and reports the write', async () => {
    const stub = runtimeStub({})
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(true)
    expect(stub.waitForTerminal).toHaveBeenCalledWith('term_1', {
      condition: 'tui-idle',
      timeoutMs: 60_000,
      // A name-only title proves nothing about a just-launched agent until its stream is quiet.
      launchReadiness: true,
      signal: expect.any(AbortSignal)
    })
    const [handle, text, options] = stub.sendTerminalAgentPrompt.mock.calls[0]!
    expect(handle).toBe('term_1')
    expect(text).toBe('do the thing')
    // Paired: without both, an unobserved first turn is raised instead of settled, and a slow
    // agent would be reported as undelivered while its prompt sat in the pane.
    expect(options.acceptQueued).toBe(true)
    expect(options.requestId).toEqual(expect.any(String))
  })

  it('does not write when the composer never opened', async () => {
    const stub = runtimeStub({ wait: { satisfied: false, status: 'blocked' } })
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    // A trust or update prompt is on screen; the text would answer whatever it asked.
    expect(delivered).toBe(false)
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('reports a stalled submission as delivered, because the stall is raised after the write', async () => {
    const stub = runtimeStub({
      send: async () => {
        throw new Error(AGENT_PROMPT_STALLED_ERROR)
      }
    })
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    // Under-claiming here would resend the whole prompt into an agent already working on it.
    expect(delivered).toBe(true)
  })

  it('under-claims when the write itself failed', async () => {
    const stub = runtimeStub({
      send: async () => {
        throw new Error('terminal_not_writable')
      }
    })
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(false)
  })

  it('does not fail the launch when the readiness wait throws', async () => {
    const stub = runtimeStub({})
    stub.waitForTerminal.mockRejectedValueOnce(new Error('terminal_handle_stale'))
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    // The agent is running; a delivery failure must never become a launch failure.
    expect(delivered).toBe(false)
  })

  it('writes nothing for blank text', async () => {
    const stub = runtimeStub({})
    expect(
      await deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        agent: 'claude',
        freshLaunch: true,
        text: '   '
      })
    ).toBe(false)
    expect(stub.waitForTerminal).not.toHaveBeenCalled()
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('waits out a blocking prompt the user dismisses, then writes', async () => {
    const blocked = { satisfied: false, status: 'running', blockedReason: 'trust-prompt' }
    const stub = runtimeStub({ waits: [blocked, blocked, { satisfied: true, status: 'running' }] })
    const clock = fakeClock()

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing',
      clock
    })

    expect(delivered).toBe(true)
    expect(stub.waitForTerminal).toHaveBeenCalledTimes(3)
    // Each re-wait spends only what is left of the one launch budget.
    expect(stub.waitForTerminal.mock.calls.at(-1)?.[1]).toMatchObject({ timeoutMs: 58_000 })
    expect(stub.sendTerminalAgentPrompt).toHaveBeenCalledTimes(1)
  })

  it('writes nothing into a blocking prompt still up when the budget ends', async () => {
    const stub = runtimeStub({
      wait: { satisfied: false, status: 'running', blockedReason: 'trust-prompt' }
    })

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing',
      clock: fakeClock()
    })

    expect(delivered).toBe(false)
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    // One check per second of a 60 s budget, then it stops rather than spinning.
    expect(stub.waitForTerminal.mock.calls.length).toBeLessThanOrEqual(60)
  })

  it('writes as soon as the composer signal fires, without waiting out the idle evidence', async () => {
    const stub = runtimeStub({ composerSignal: true, idlePending: true })

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(true)
    expect(stub.waitForFreshWorkerComposer).toHaveBeenCalledWith('term_1', 'claude', 60_000, {
      requireComposerMarker: false,
      signal: expect.any(AbortSignal)
    })
    expect(stub.waitForTerminal.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it.each(['zcode', 'dsh', 'grok'] as const)('waits for %s’s composer readiness', async (agent) => {
    const stub = runtimeStub({ composerSignal: true })

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent,
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(true)
    expect(stub.waitForFreshWorkerComposer).toHaveBeenCalledWith(
      'term_1',
      agent,
      60_000,
      expect.anything()
    )
    expect(stub.waitForTerminal).not.toHaveBeenCalled()
  })

  it('keeps the text when an agent shows no readiness evidence at all', async () => {
    // Nothing is pasted blind.
    const stub = runtimeStub({ wait: { satisfied: false, status: 'running' } })

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'goose',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(false)
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
  it('never lets a re-wait fall back to the terminal wait’s 5-minute default', async () => {
    // A late 1 s re-check sleep can land past the deadline; 0 would read as "use the default".
    const stub = runtimeStub({
      wait: { satisfied: false, status: 'running', blockedReason: 'trust-prompt' }
    })
    let now = 0
    const lateClock = {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms + 1_000
      }
    }

    await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing',
      clock: lateClock
    })

    for (const [, options] of stub.waitForTerminal.mock.calls) {
      expect(options?.timeoutMs).toBeGreaterThan(0)
    }
  })

  it('waits on a reused terminal’s idle state, not a fresh launch’s composer marker', async () => {
    // A long-running grok pane may no longer show its composer marker in recent output.
    const stub = runtimeStub({})

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_existing',
      agent: 'grok',
      freshLaunch: false,
      text: 'do the thing'
    })

    expect(delivered).toBe(true)
    expect(stub.waitForFreshWorkerComposer).not.toHaveBeenCalled()
    expect(stub.waitForTerminal).toHaveBeenCalledWith('term_existing', {
      condition: 'tui-idle',
      timeoutMs: 60_000
    })
  })
})

function fakeClock() {
  let now = 0
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
    }
  }
}
