import { describe, expect, it } from 'vitest'
import { judgeBlockedAgainstLiveScreen } from './live-screen-blocked-judgement'

describe('judgeBlockedAgainstLiveScreen', () => {
  it('keeps the tail verdict when there is no current screen', () => {
    for (const tailVerdict of ['agent-interactive-prompt', null] as const) {
      expect(
        judgeBlockedAgainstLiveScreen({ tailVerdict, screenReason: undefined, agentWorking: false })
      ).toBe(tailVerdict)
    }
  })

  it('clears tail text the screen no longer shows', () => {
    expect(
      judgeBlockedAgainstLiveScreen({
        tailVerdict: 'agent-interactive-prompt',
        screenReason: null,
        agentWorking: false
      })
    ).toBeNull()
  })

  it('reports a dialog only the screen shows unless the agent is working', () => {
    const screenOnly = { tailVerdict: null, screenReason: 'agent-trust-workspace' } as const
    expect(judgeBlockedAgainstLiveScreen({ ...screenOnly, agentWorking: false })).toBe(
      'agent-trust-workspace'
    )
    expect(judgeBlockedAgainstLiveScreen({ ...screenOnly, agentWorking: true })).toBeNull()
  })

  it('reports a dialog both show even mid-turn', () => {
    expect(
      judgeBlockedAgainstLiveScreen({
        tailVerdict: 'agent-approval-prompt',
        screenReason: 'agent-approval-prompt',
        agentWorking: true
      })
    ).toBe('agent-approval-prompt')
  })
})
