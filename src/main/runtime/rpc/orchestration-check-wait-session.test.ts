/**
 * A chat's blocking `check --wait` is a terminal's: the host waits the budget asked for. A provider
 * shell tool that outlives its own timeout backgrounds or yields the command rather than killing it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  WORKER_HANDLE,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const TERMINAL_WAIT_MS = 600_000

describe('check --wait from an agent session', () => {
  let h: SessionCallerHarness
  let runId: string

  beforeEach(async () => {
    h = createSessionCallerHarness(hostRef)
    const chat = h.records.get(SESSION_X)!
    h.records.set(SESSION_X, { ...chat, provider: 'codex' })
    const created = resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { objective: 'chat coordinator' },
          { sessionId: SESSION_X }
        )
      )
    )
    runId = idOf(created.run)
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  function check(params: Record<string, unknown>) {
    return h.dispatch(orchestrationRequest('orchestration.check', params, { sessionId: SESSION_X }))
  }

  it('waits the budget a chat asked for, as it would for a terminal', async () => {
    const waitForMessage = vi.spyOn(h.runtime, 'waitForMessage').mockResolvedValue('timed_out')

    expect(resultOf(await check({ wait: true, timeoutMs: TERMINAL_WAIT_MS }))).toMatchObject({
      runId,
      count: 0,
      timedOut: true
    })
    await h.dispatch(
      orchestrationRequest('orchestration.check', {
        terminal: WORKER_HANDLE,
        wait: true,
        timeoutMs: TERMINAL_WAIT_MS
      })
    )

    expect(waitForMessage).toHaveBeenCalledTimes(2)
    for (const [, options] of waitForMessage.mock.calls) {
      expect(options).toMatchObject({ timeoutMs: TERMINAL_WAIT_MS })
    }
  })

  it('returns at once when mail is already waiting', async () => {
    const waitForMessage = vi.spyOn(h.runtime, 'waitForMessage')
    h.db.insertMessage({ from: 'term_peer', to: `run:${runId}`, runId, subject: 'done' })

    const result = resultOf(await check({ wait: true, timeoutMs: TERMINAL_WAIT_MS }))

    expect(result).toMatchObject({ runId, count: 1, timedOut: false })
    expect(waitForMessage).not.toHaveBeenCalled()
  })
})
