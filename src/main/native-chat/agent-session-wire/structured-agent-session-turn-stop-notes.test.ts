import { describe, expect, it } from 'vitest'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import {
  structuredAgentSessionStopEventTurnId,
  structuredAgentSessionStopNoteKey
} from './structured-agent-session-turn-stop-notes'

const journal = { activeTurnId: () => 'turn-live' }

describe("a Stop's note key", () => {
  it('names the turn the Stop named, as its event records it', () => {
    const turnId = structuredAgentSessionStopEventTurnId(journal, {
      namedTurnId: 'turn-old',
      endsSession: false
    })
    expect(structuredAgentSessionStopNoteKey(turnId, 'op-1')).toEqual(
      structuredAgentSessionStopNoteIdentity('turn-old')
    )
  })

  // Its event names whatever is in flight, never a named turn that already ended.
  it('names the running turn for a Stop that ends the provider session, whatever it named', () => {
    const turnId = structuredAgentSessionStopEventTurnId(journal, {
      namedTurnId: 'turn-old',
      endsSession: true
    })
    expect(structuredAgentSessionStopNoteKey(turnId, 'op-1')).toEqual(
      structuredAgentSessionStopNoteIdentity('turn-live')
    )
  })

  it('falls back to the operation with no turn running', () => {
    const turnId = structuredAgentSessionStopEventTurnId(
      { activeTurnId: () => null },
      { endsSession: true }
    )
    expect(structuredAgentSessionStopNoteKey(turnId, 'op-1')).toEqual(
      structuredAgentSessionStopNoteIdentity('op-1')
    )
  })
})
