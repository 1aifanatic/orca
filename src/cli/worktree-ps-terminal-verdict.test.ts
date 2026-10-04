import { describe, expect, it } from 'vitest'
import {
  formatWorktreePsTerminalFields,
  projectWorktreePsTerminalVerdict
} from './worktree-ps-terminal-verdict'

describe('worktree ps terminal verdict', () => {
  it('prints counts for a reachable host', () => {
    const row = { liveTerminalCount: 2, hasAttachedPty: true }
    expect(formatWorktreePsTerminalFields(row)).toBe('live:2  pty:yes')
    expect(projectWorktreePsTerminalVerdict(row)).toEqual(row)
  })

  it('prints unverifiable, never zero or no, for an unreachable host', () => {
    const row = { liveTerminalCount: 0, hasAttachedPty: false, unverifiableTerminalCount: 1 }
    expect(formatWorktreePsTerminalFields(row)).toBe('live:unverifiable  pty:unverifiable')
    expect(projectWorktreePsTerminalVerdict(row)).toEqual({
      liveTerminalCount: 'unverifiable',
      hasAttachedPty: 'unverifiable',
      unverifiableTerminalCount: 1
    })
  })

  it('keeps verified terminals alongside unverifiable ones', () => {
    const row = { liveTerminalCount: 1, hasAttachedPty: true, unverifiableTerminalCount: 2 }
    expect(formatWorktreePsTerminalFields(row)).toBe('live:1+2 unverifiable  pty:yes')
    expect(projectWorktreePsTerminalVerdict(row)).toEqual(row)
  })

  it('prints zero and no for a host that confirmed every exit', () => {
    const row = { liveTerminalCount: 0, hasAttachedPty: false }
    expect(formatWorktreePsTerminalFields(row)).toBe('live:0  pty:no')
    expect(projectWorktreePsTerminalVerdict(row)).toEqual(row)
  })
})
