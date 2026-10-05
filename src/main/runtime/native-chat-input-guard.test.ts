import { describe, expect, it } from 'vitest'
import { NativeChatInputGuard } from './native-chat-input-guard'

describe('NativeChatInputGuard', () => {
  it('admits chat actions until the host proves the agent exited, then refuses new ones', () => {
    const guard = new NativeChatInputGuard()
    expect(guard.admit('pty-1', 'inc-1', 'a1')).toBe('admitted')
    guard.confirmExit('pty-1', 'inc-1')
    expect(guard.admit('pty-1', 'inc-1', 'a2')).toBe('agent-exited')
  })

  it('cancels an action started before the exit for good, even after new agent evidence', () => {
    const guard = new NativeChatInputGuard()
    expect(guard.admit('pty-1', 'inc-1', 'body-then-enter')).toBe('admitted')
    guard.confirmExit('pty-1', 'inc-1')
    guard.clearExit('pty-1')
    // The delayed Enter of the old action must never reach the replacement agent.
    expect(guard.recheck('pty-1', 'inc-1', 'body-then-enter')).toBe('agent-exited')
    expect(guard.admit('pty-1', 'inc-1', 'new-action')).toBe('admitted')
  })

  it('scopes a proven exit to its PTY incarnation and forgets it when the PTY exits', () => {
    const guard = new NativeChatInputGuard()
    guard.confirmExit('pty-1', 'inc-1')
    expect(guard.admit('pty-1', 'inc-2', 'a1')).toBe('admitted')
    expect(guard.admit('pty-2', 'inc-1', 'a1')).toBe('admitted')
    guard.confirmExit('pty-1', 'inc-2')
    guard.forget('pty-1')
    expect(guard.admit('pty-1', 'inc-2', 'a3')).toBe('admitted')
  })

  it('bounds the ids it remembers per PTY', () => {
    const guard = new NativeChatInputGuard()
    for (let index = 0; index < 200; index += 1) {
      guard.admit('pty-1', 'inc-1', `a${index}`)
    }
    guard.confirmExit('pty-1', 'inc-1')
    guard.clearExit('pty-1')
    expect(guard.recheck('pty-1', 'inc-1', 'a199')).toBe('agent-exited')
    expect(guard.recheck('pty-1', 'inc-1', 'a0')).toBe('admitted')
  })
})
