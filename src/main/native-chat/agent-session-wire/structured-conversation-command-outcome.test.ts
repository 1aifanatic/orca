import { describe, expect, it } from 'vitest'
import { structuredCompactionOutcome } from './structured-conversation-command-outcome'

describe('structuredCompactionOutcome', () => {
  it('is a success only when the provider reported the compaction', () => {
    expect(structuredCompactionOutcome({ compacted: true, interruptRequested: true })).toEqual({
      outcome: 'success'
    })
  })

  it("reads no compaction after Orca's interrupt as the user's cancellation", () => {
    expect(
      structuredCompactionOutcome({
        compacted: false,
        interruptRequested: true,
        error: 'API Error: Request was aborted.'
      })
    ).toEqual({ outcome: 'cancellation' })
  })

  it('reads any other missing compaction as a failure, with the reason the provider gave', () => {
    expect(
      structuredCompactionOutcome({
        compacted: false,
        interruptRequested: false,
        error: 'Not enough messages to compact.'
      })
    ).toEqual({ outcome: 'failure', error: 'Not enough messages to compact.' })
    expect(structuredCompactionOutcome({ compacted: false, interruptRequested: false })).toEqual({
      outcome: 'failure',
      error: 'Compaction was not confirmed by the provider.'
    })
  })
})
