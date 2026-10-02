// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { AgentSessionReadOnlyReason } from '../../../../shared/agent-session-read-only'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  type StructuredAgentSessionState
} from '../../../../shared/structured-agent-session-reducer'
import { useStructuredAgentSessionTransportState } from './use-structured-agent-session-transport-state'

/** A chat whose turn opened and never settled, and a send never answered, as a read-only host
 *  leaves them. */
function openTurn(readOnly?: AgentSessionReadOnlyReason): StructuredAgentSessionState {
  return {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    epoch: 'epoch-1',
    fence: 1,
    status: 'ready',
    items: [
      {
        itemId: 'turn-1',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: { kind: 'turn', turnId: 'turn-1', state: 'running' }
      }
    ],
    // A send the provider never answered: on a writable chat it alone reads as working.
    submissions: [
      {
        clientMessageId: 'send-1',
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'pending',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
    ],
    backgroundTasks: { state: 'monitoring', tasks: [], supportsTaskStop: true },
    ...(readOnly ? { readOnly } : {})
  }
}

function transport(state: StructuredAgentSessionState) {
  return renderHook(() => useStructuredAgentSessionTransportState(state, true)).result.current
}

it('a read-only chat has the words for why, no turn and no work, as its host projects it', () => {
  const readOnly = transport(openTurn('written-by-newer-orca'))
  expect(readOnly).toMatchObject({
    readOnly: 'Saved by a newer Orca. Update Orca to continue this chat.',
    turnId: null,
    isWorking: false,
    backgroundTasks: { supportsStop: false, supportsStopAll: false }
  })
  expect(transport(openTurn())).toMatchObject({
    readOnly: undefined,
    turnId: 'turn-1',
    isWorking: true,
    backgroundTasks: { supportsStop: true }
  })
})

it('a reason this client cannot word leaves the chat as the journal says', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stands in for an arm a newer host could publish, which this build's type cannot name.
  const later = transport(openTurn('a-later-reason' as AgentSessionReadOnlyReason))
  expect(later).toMatchObject({ readOnly: undefined, turnId: 'turn-1', isWorking: true })
})
