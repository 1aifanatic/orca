import { describe, expect, it, vi } from 'vitest'
import { StructuredSessionCompaction } from './structured-session-compaction'

const COMMAND = { turnId: 'compact:cmd-1', turnItemId: 'orca:command-turn:cmd-1' }
const CLAUDE_COMMAND = { ...COMMAND, sentUuid: 'compact-input' }

describe('structured compaction lifecycle', () => {
  it('waits beyond the Codex acknowledgment for the claimed turn and ignores other threads', async () => {
    const tracker = new StructuredSessionCompaction()
    const finished = vi.fn()
    const result = tracker
      .run('thread', async () => ({}), COMMAND)
      .then((value) => {
        finished()
        return value
      })
    await Promise.resolve()
    expect(tracker.claimTurn('other', 'foreign')).toBeNull()
    tracker.codex('turn/completed', {
      threadId: 'other',
      turn: { id: 'foreign', status: 'completed' }
    })
    expect(tracker.claimTurn('thread', 'compact-turn')).toBe(COMMAND.turnItemId)
    tracker.codex('item/completed', {
      threadId: 'thread',
      item: { type: 'contextCompaction' }
    })
    expect(finished).not.toHaveBeenCalled()
    tracker.codex('turn/completed', {
      threadId: 'thread',
      turn: { id: 'compact-turn', status: 'completed' }
    })
    await expect(result).resolves.toEqual({ outcome: 'success' })
    expect(tracker.running).toBe(false)
  })

  it('claims one provider turn, the same one on a retry, and no other', async () => {
    const tracker = new StructuredSessionCompaction()
    void tracker.run('t', async () => ({}), COMMAND)
    await Promise.resolve()
    expect(tracker.claimTurn('t', 'c')).toBe(COMMAND.turnItemId)
    expect(tracker.claimTurn('t', 'c')).toBe(COMMAND.turnItemId)
    expect(tracker.claimTurn('t', 'later')).toBeNull()
    expect(tracker.providerTurnId(COMMAND.turnId)).toBe('c')
  })

  it('observes notifications arriving before the request acknowledgment', async () => {
    const tracker = new StructuredSessionCompaction()
    await expect(
      tracker.run(
        't',
        async () => {
          tracker.claimTurn('t', 'c')
          tracker.codex('turn/completed', {
            threadId: 't',
            turn: { id: 'c', status: 'failed', error: { message: 'Unavailable' } }
          })
        },
        COMMAND
      )
    ).resolves.toEqual({ outcome: 'failure', error: 'Unavailable' })
  })

  it('reads an interrupted Codex turn as a cancellation', async () => {
    const tracker = new StructuredSessionCompaction()
    const result = tracker.run('t', async () => ({}), COMMAND)
    await Promise.resolve()
    tracker.claimTurn('t', 'c')
    tracker.codex('turn/completed', {
      threadId: 't',
      turn: { id: 'c', status: 'interrupted' }
    })
    await expect(result).resolves.toEqual({ outcome: 'cancellation' })
  })

  it.each(['success', 'failed'])(
    'uses Claude compact_result %s rather than result subtype',
    async (state) => {
      const tracker = new StructuredSessionCompaction()
      const result = tracker.run('provider', async () => {}, CLAUDE_COMMAND)
      tracker.claude({
        type: 'system',
        subtype: 'status',
        session_id: 'provider',
        compact_result: state,
        compact_error: 'Not enough messages to compact.'
      })
      tracker.claude({
        type: 'result',
        subtype: 'success',
        session_id: 'provider',
        user_message_uuid: CLAUDE_COMMAND.sentUuid,
        result: ''
      })
      await expect(result).resolves.toEqual(
        state === 'success'
          ? { outcome: 'success' }
          : { outcome: 'failure', error: 'Not enough messages to compact.' }
      )
    }
  )

  it('ends a Claude command only on the result that answers its own input', async () => {
    const tracker = new StructuredSessionCompaction()
    const settled = vi.fn()
    void tracker.run('p', async () => {}, CLAUDE_COMMAND).then(settled)
    tracker.claude({ type: 'system', subtype: 'compact_boundary', session_id: 'p' })
    // Another input's result, and a subagent's, answer something else.
    tracker.claude({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: 'p',
      user_message_uuid: 'earlier-input'
    })
    tracker.claude({
      type: 'result',
      subtype: 'success',
      session_id: 'p',
      parent_tool_use_id: 'task-1',
      user_message_uuid: CLAUDE_COMMAND.sentUuid
    })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(tracker.running).toBe(true)

    tracker.claude({
      type: 'result',
      subtype: 'success',
      session_id: 'p',
      user_message_uuid: CLAUDE_COMMAND.sentUuid
    })
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith({ outcome: 'success' }))
  })

  it("takes a result that names no input as the command's, the only input in flight", async () => {
    const tracker = new StructuredSessionCompaction()
    const result = tracker.run('p', async () => {}, CLAUDE_COMMAND)
    tracker.claude({ type: 'system', subtype: 'compact_boundary', session_id: 'p' })
    tracker.claude({ type: 'result', subtype: 'success', session_id: 'p' })
    await expect(result).resolves.toEqual({ outcome: 'success' })
  })

  it('reads an interrupted Claude command as a cancellation, not a failure', async () => {
    const tracker = new StructuredSessionCompaction()
    const result = tracker.run('p', async () => {}, CLAUDE_COMMAND)
    tracker.claude({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_streaming',
      session_id: 'p',
      user_message_uuid: CLAUDE_COMMAND.sentUuid
    })
    await expect(result).resolves.toEqual({ outcome: 'cancellation' })
  })

  it('reads a Claude error result that was not a stop as a failure', async () => {
    const tracker = new StructuredSessionCompaction()
    const result = tracker.run('p', async () => {}, CLAUDE_COMMAND)
    tracker.claude({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: 'p',
      user_message_uuid: CLAUDE_COMMAND.sentUuid
    })
    await expect(result).resolves.toEqual({
      outcome: 'failure',
      error: 'Compaction did not complete.'
    })
  })

  it('runs another command once the first ended', async () => {
    const tracker = new StructuredSessionCompaction()
    const first = tracker.run('p', async () => {}, CLAUDE_COMMAND)
    await expect(tracker.run('p', async () => {}, CLAUDE_COMMAND)).rejects.toThrow(
      'Compaction is already running.'
    )
    tracker.claude({ type: 'result', subtype: 'success', session_id: 'p' })
    await first
    const next = tracker.run(
      'p',
      async () => {
        tracker.claude({ type: 'system', subtype: 'compact_boundary', session_id: 'p' })
        tracker.claude({ type: 'result', subtype: 'success', session_id: 'p' })
      },
      CLAUDE_COMMAND
    )
    await expect(next).resolves.toEqual({ outcome: 'success' })
  })

  it('does not mistake an unrelated completed turn for compaction', async () => {
    const tracker = new StructuredSessionCompaction()
    const result = tracker.run('t', async () => ({}), COMMAND)
    await Promise.resolve()
    tracker.claimTurn('t', 'c')
    tracker.codex('turn/completed', { threadId: 't', turn: { id: 'c', status: 'completed' } })
    await expect(result).resolves.toEqual({
      outcome: 'failure',
      error: 'Compaction did not complete.'
    })
  })

  it('releases the entry when the send itself throws', async () => {
    const tracker = new StructuredSessionCompaction()
    await expect(
      tracker.run(
        'p',
        async () => {
          throw new Error('pipe closed')
        },
        COMMAND
      )
    ).rejects.toThrow('pipe closed')
    expect(tracker.running).toBe(false)
  })
})
