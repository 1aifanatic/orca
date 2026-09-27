import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeUnwrittenUserMessageError } from './claude-agent-sdk-user-message-queue'
import { compactClaudeSession, isClaudeCompactionContent } from './claude-structured-compaction'
import { sessionFor } from './claude-structured-dispatch-test-support'

afterEach(() => {
  vi.useRealTimers()
})

const COMMAND = { turnId: 'compact:cmd-1', turnItemId: 'orca:command-turn:cmd-1' }

function summaryFrame(extra: Record<string, unknown> = {}) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'user',
      session_id: 'provider-session',
      uuid: 'summary',
      message: { role: 'user', content: 'generated compaction summary' },
      ...extra
    }
  }
}

describe('Claude compaction transcript content', () => {
  it("keeps the command's own output out of the transcript only while it runs on that child", async () => {
    const session = sessionFor()
    const event = summaryFrame()
    expect(isClaudeCompactionContent(session, event)).toBe(false)
    const completion = compactClaudeSession(session, {
      sessionId: 'orca-session',
      fence: 1,
      ...COMMAND
    })
    expect(isClaudeCompactionContent(session, event)).toBe(true)
    // Another child, a subagent's frame and the result all pass through.
    expect(isClaudeCompactionContent(sessionFor(), event)).toBe(false)
    expect(isClaudeCompactionContent(session, summaryFrame({ parent_tool_use_id: 'task' }))).toBe(
      false
    )
    expect(isClaudeCompactionContent(session, { ...event, message: { type: 'result' } })).toBe(
      false
    )
    session.compaction.claude({
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'provider-session'
    })
    session.compaction.claude({
      type: 'result',
      subtype: 'success',
      session_id: 'provider-session'
    })
    await expect(completion).resolves.toEqual({ outcome: 'success' })
    expect(isClaudeCompactionContent(session, event)).toBe(false)
  })

  it('sends /compact under the uuid its result is matched by', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const session = sessionFor(send)
    const settled = vi.fn()
    void compactClaudeSession(session, { sessionId: 'orca-session', fence: 1, ...COMMAND }).then(
      settled
    )
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    const sentUuid = String(send.mock.calls[0]![0].uuid)

    session.compaction.claude({
      type: 'result',
      subtype: 'success',
      session_id: 'provider-session',
      user_message_uuid: 'another-input'
    })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    session.compaction.claude({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_tools',
      session_id: 'provider-session',
      user_message_uuid: sentUuid
    })
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith({ outcome: 'cancellation' }))
  })

  it('fails a provably unwritten command at once', async () => {
    const session = sessionFor(
      vi.fn().mockRejectedValue(claudeUnwrittenUserMessageError(new Error('input closed')))
    )
    const pending = compactClaudeSession(session, {
      sessionId: 'orca-session',
      fence: 1,
      ...COMMAND
    })

    await expect(pending).resolves.toEqual({
      outcome: 'failure',
      error: 'provider_write_failed: input closed'
    })
  })

  it('keeps waiting, with no deadline, when the command write outcome is ambiguous', async () => {
    vi.useFakeTimers()
    const session = sessionFor(vi.fn().mockRejectedValue(new Error('input pump stopped')))
    const settled = vi.fn()
    void compactClaudeSession(session, { sessionId: 'orca-session', fence: 1, ...COMMAND })
      .then(settled)
      .catch(settled)

    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(settled).not.toHaveBeenCalled()
    expect(session.compaction.running).toBe(true)
  })
})
