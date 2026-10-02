import { describe, expect, it } from 'vitest'
import type { AgentSessionTurnActivity } from '../../../shared/agent-session-wire'
import { createTurnActivityChannel, MAX_OPEN_REASONING_SUBAGENTS } from './turn-activity-channel'

function channel() {
  const sent: (AgentSessionTurnActivity | null)[] = []
  return { sent, activity: createTurnActivityChannel({ setActivity: (next) => sent.push(next) }) }
}

const OPEN = { session: true, subagents: [] }
const CLOSED = { session: false, subagents: [] }

describe('the live turn activity channel', () => {
  it('composes the words and the open reasoning, neither clearing the other', () => {
    const { sent, activity } = channel()
    activity.setReasoning('turn-1', OPEN)
    activity.setText('turn-1', 'Thinking through the request')
    activity.setText('turn-1', null)
    activity.setReasoning('turn-1', CLOSED)
    expect(sent).toEqual([
      { turnId: 'turn-1', text: '', reasoning: OPEN },
      { turnId: 'turn-1', text: 'Thinking through the request', reasoning: OPEN },
      { turnId: 'turn-1', text: '', reasoning: OPEN },
      null
    ])
  })

  it('sends words alone exactly as before when nothing is reasoning', () => {
    const { sent, activity } = channel()
    activity.setText('turn-1', 'Running a command')
    activity.setReasoning('turn-1', CLOSED)
    expect(sent).toEqual([{ turnId: 'turn-1', text: 'Running a command' }])
  })

  it('publishes nothing when nothing changed, but always sends a clear', () => {
    const { sent, activity } = channel()
    activity.setReasoning('turn-1', OPEN)
    activity.setReasoning('turn-1', { session: true, subagents: [] })
    activity.setText('turn-1', undefined)
    expect(sent).toHaveLength(1)
    activity.clear()
    activity.clear()
    expect(sent).toEqual([{ turnId: 'turn-1', text: '', reasoning: OPEN }, null, null])
  })

  it("drops the previous turn's words when a new turn reports", () => {
    const { sent, activity } = channel()
    activity.setText('turn-1', 'Editing files')
    activity.setReasoning('turn-2', OPEN)
    expect(sent.at(-1)).toEqual({ turnId: 'turn-2', text: '', reasoning: OPEN })
    activity.setReasoning(null, OPEN)
    expect(sent.at(-1)).toBeNull()
  })

  it('names each subagent once, in a stable order, and boundedly', () => {
    const { sent, activity } = channel()
    activity.setReasoning('turn-1', { session: false, subagents: ['b', 'a', 'b'] })
    activity.setReasoning('turn-1', { session: false, subagents: ['a', 'b'] })
    expect(sent).toEqual([
      { turnId: 'turn-1', text: '', reasoning: { session: false, subagents: ['a', 'b'] } }
    ])
    const many = Array.from({ length: MAX_OPEN_REASONING_SUBAGENTS + 8 }, (_, i) => `agent-${i}`)
    activity.setReasoning('turn-1', { session: false, subagents: many })
    expect(sent.at(-1)?.reasoning?.subagents).toHaveLength(MAX_OPEN_REASONING_SUBAGENTS)
  })
})
