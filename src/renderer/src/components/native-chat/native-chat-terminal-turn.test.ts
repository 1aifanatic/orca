import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import {
  nativeChatHookTurnStartedAt,
  nativeChatTranscriptSettledTurns,
  resolveNativeChatTerminalTurn
} from './native-chat-terminal-turn'

const idle = {
  isConversation: true,
  working: false,
  hookAwaitingInput: false,
  interrupted: false,
  hasPromptCard: false
}

describe('resolveNativeChatTerminalTurn', () => {
  it('keeps the turn running while the agent waits, without calling it generating', () => {
    expect(resolveNativeChatTerminalTurn({ ...idle, hookAwaitingInput: true })).toEqual({
      isWorking: false,
      turnActive: true,
      awaitingInput: 'unshown'
    })
  })

  it('lets a prompt card speak for the wait', () => {
    expect(
      resolveNativeChatTerminalTurn({ ...idle, hookAwaitingInput: true, hasPromptCard: true })
    ).toEqual({ isWorking: false, turnActive: true, awaitingInput: 'shown' })
  })

  it('reports a generating turn with nothing awaited', () => {
    expect(resolveNativeChatTerminalTurn({ ...idle, working: true })).toEqual({
      isWorking: true,
      turnActive: true,
      awaitingInput: null
    })
  })

  // Stop is the reader's word that the turn is over, whatever the hook still says.
  it('ends the turn on local Stop, wait included', () => {
    expect(
      resolveNativeChatTerminalTurn({
        ...idle,
        working: true,
        hookAwaitingInput: true,
        interrupted: true
      })
    ).toEqual({ isWorking: false, turnActive: false, awaitingInput: null })
  })

  it('stays quiet with no turn at all', () => {
    expect(resolveNativeChatTerminalTurn(idle)).toEqual({
      isWorking: false,
      turnActive: false,
      awaitingInput: null
    })
  })
})

describe('nativeChatHookTurnStartedAt', () => {
  const entry = {
    state: 'working' as const,
    prompt: 'Rename the module',
    stateStartedAt: 3_000,
    stateHistory: [
      { state: 'done' as const, prompt: 'Earlier ask', startedAt: 500 },
      { state: 'working' as const, prompt: 'Rename the module', startedAt: 1_000 },
      { state: 'waiting' as const, prompt: 'Rename the module', startedAt: 2_000 }
    ]
  }

  // Answered in the terminal: the current state began at 3s, the turn at 1s.
  it('dates the turn from before the wait it came back from', () => {
    expect(nativeChatHookTurnStartedAt(entry)).toBe(1_000)
  })

  it('ends the run at a finished turn', () => {
    expect(
      nativeChatHookTurnStartedAt({
        ...entry,
        stateHistory: [
          { state: 'working', prompt: 'Rename the module', startedAt: 100 },
          { state: 'done', prompt: 'Rename the module', startedAt: 900 },
          { state: 'waiting', prompt: 'Rename the module', startedAt: 2_000 }
        ]
      })
    ).toBe(2_000)
  })

  // A wait interrupted at its prompt fires no hook, so the next turn follows it directly.
  it('ends the run at a different prompt', () => {
    expect(
      nativeChatHookTurnStartedAt({
        ...entry,
        prompt: 'Now add tests',
        stateHistory: entry.stateHistory
      })
    ).toBe(3_000)
  })

  it('knows nothing without a status row', () => {
    expect(nativeChatHookTurnStartedAt(undefined)).toBeNull()
  })
})

function row(
  id: string,
  role: NativeChatMessage['role'],
  timestamp: number | null
): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text: id }], timestamp, source: 'transcript' }
}

describe('nativeChatTranscriptSettledTurns', () => {
  it('times each finished turn from its prompt to its last row, leaving the latest out', () => {
    const settled = nativeChatTranscriptSettledTurns([
      row('u1', 'user', 10_000),
      row('a1', 'assistant', 20_000),
      row('a2', 'assistant', 55_900),
      row('u2', 'user', 70_000),
      row('a3', 'assistant', 80_000)
    ])
    expect([...settled]).toEqual([['u1', { startedAt: 10_000, workedSeconds: 45 }]])
  })

  it('ends an interrupted turn at its interruption', () => {
    const settled = nativeChatTranscriptSettledTurns([
      row('u1', 'user', 0),
      row('a1', 'assistant', 5_000),
      {
        ...row('stop', 'system', 12_000),
        blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }]
      },
      row('u2', 'user', 60_000)
    ])
    expect(settled.get('u1')).toEqual({ startedAt: 0, workedSeconds: 12 })
  })

  // An attachment row sits beside the next prompt; it does not stretch the turn before it.
  it('does not end a turn at a system row the agent did not write', () => {
    const settled = nativeChatTranscriptSettledTurns([
      row('u1', 'user', 0),
      row('a1', 'assistant', 5_000),
      row('@src/index.ts', 'system', 3_600_000),
      row('u2', 'user', 3_601_000)
    ])
    expect(settled.get('u1')).toEqual({ startedAt: 0, workedSeconds: 5 })
  })

  // Absent, not null: null would also hide the duration the pane measured itself.
  it('leaves out a turn missing either end', () => {
    const settled = nativeChatTranscriptSettledTurns([
      row('u1', 'user', null),
      row('a1', 'assistant', 5_000),
      row('u2', 'user', 10_000),
      row('a2', 'assistant', null),
      row('u3', 'user', 20_000)
    ])
    expect(settled.size).toBe(0)
  })
})
