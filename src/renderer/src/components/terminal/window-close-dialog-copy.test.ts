import { describe, expect, it } from 'vitest'
import { describeWindowCloseRunningWork } from './window-close-dialog-copy'

describe('describeWindowCloseRunningWork', () => {
  it('tells the user a host they disconnected keeps its terminals', () => {
    expect(
      describeWindowCloseRunningWork({ kind: 'user-disconnected', hostLabels: ['devbox', 'gpu'] })
    ).toBe('You disconnected devbox, gpu. Terminals there keep running. Close the window anyway?')
  })

  it('keeps the unreachable copy for a host that went quiet on its own', () => {
    expect(
      describeWindowCloseRunningWork({ kind: 'unverifiable', userDisconnectedHostLabels: [] })
    ).toBe(
      'A remote host could not be reached, so Orca cannot tell whether work is still running there. Close the window anyway?'
    )
  })

  it('names both when one host was disconnected and another could not be reached', () => {
    expect(
      describeWindowCloseRunningWork({
        kind: 'unverifiable',
        userDisconnectedHostLabels: ['devbox']
      })
    ).toBe(
      'You disconnected devbox. Terminals there keep running. Another remote host could not be reached, so Orca cannot tell whether work is still running there. Close the window anyway?'
    )
  })
})
