import { describe, expect, it } from 'vitest'
import { agentSaysNotWaiting, judgeBlockedAgainstLiveScreen } from './live-screen-blocked-judgement'

const TAIL = 'agent-interactive-prompt' as const

describe('judgeBlockedAgainstLiveScreen', () => {
  it('keeps the tail verdict when there is no current screen', () => {
    for (const tailVerdict of [TAIL, null]) {
      expect(
        judgeBlockedAgainstLiveScreen({
          tailVerdict,
          tailShowsBlockedText: tailVerdict !== null,
          screen: undefined,
          agentSaysNotWaiting: false
        })
      ).toBe(tailVerdict)
    }
  })

  it('clears tail text only when the screen shows the ready prompt instead', () => {
    const judge = (showsReadyPrompt: boolean) =>
      judgeBlockedAgainstLiveScreen({
        tailVerdict: TAIL,
        tailShowsBlockedText: true,
        screen: { blockedReason: null, showsReadyPrompt },
        agentSaysNotWaiting: false
      })
    expect(judge(true)).toBeNull()
    expect(judge(false)).toBe(TAIL)
  })

  it('reports a dialog only the screen shows unless the agent says it is not waiting', () => {
    const judge = (agentSaysNotWaiting: boolean) =>
      judgeBlockedAgainstLiveScreen({
        tailVerdict: null,
        tailShowsBlockedText: false,
        screen: { blockedReason: 'agent-trust-workspace', showsReadyPrompt: false },
        agentSaysNotWaiting
      })
    expect(judge(false)).toBe('agent-trust-workspace')
    expect(judge(true)).toBeNull()
  })

  it('keeps the arbiter clearing blocked text the tail shows too', () => {
    expect(
      judgeBlockedAgainstLiveScreen({
        tailVerdict: null,
        tailShowsBlockedText: true,
        screen: { blockedReason: 'agent-trust-workspace', showsReadyPrompt: false },
        agentSaysNotWaiting: false
      })
    ).toBeNull()
  })

  it('reports a dialog both show even mid-turn', () => {
    expect(
      judgeBlockedAgainstLiveScreen({
        tailVerdict: 'agent-approval-prompt',
        tailShowsBlockedText: true,
        screen: { blockedReason: 'agent-approval-prompt', showsReadyPrompt: false },
        agentSaysNotWaiting: true
      })
    ).toBe('agent-approval-prompt')
  })
})

describe('agentSaysNotWaiting', () => {
  it('reads a working title, an explicit idle title, or a non-permission hook status', () => {
    expect(agentSaysNotWaiting({ title: 'claude', titleStatus: 'working' }, null)).toBe(true)
    expect(agentSaysNotWaiting({ title: 'Codex ready', titleStatus: 'idle' }, null)).toBe(true)
    expect(agentSaysNotWaiting({ title: 'claude', titleStatus: 'idle' }, { status: 'idle' })).toBe(
      true
    )
  })

  it('does not read a name-only shell title or a permission hook status', () => {
    expect(agentSaysNotWaiting({ title: 'claude', titleStatus: 'idle' }, null)).toBe(false)
    expect(
      agentSaysNotWaiting({ title: 'claude', titleStatus: 'idle' }, { status: 'permission' })
    ).toBe(false)
  })
})
