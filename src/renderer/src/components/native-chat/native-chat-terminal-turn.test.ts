import { describe, expect, it } from 'vitest'
import { resolveNativeChatTerminalTurn } from './native-chat-terminal-turn'

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
