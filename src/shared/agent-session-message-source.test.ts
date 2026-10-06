import { describe, expect, it } from 'vitest'
import { testOrcaSessionId } from './orca-session-address-test-fixture'
import {
  readAgentSessionMessageSource,
  serializeAgentSessionMessageSource,
  USER_MESSAGE_SOURCE,
  type AgentMessageSource
} from './agent-session-message-source'

const COORDINATOR = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')

const TASK: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: {
        address: `orca_session_id:${COORDINATOR}`,
        terminalHandle: null,
        orcaSessionId: COORDINATOR
      }
    }
  ],
  orchestration: { message: 'task', runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1' }
}

function stored(source: AgentMessageSource): unknown {
  return JSON.parse(serializeAgentSessionMessageSource(source))
}

describe('a queued card source', () => {
  it("reads a Dispatch's task back as written", () => {
    expect(readAgentSessionMessageSource(stored(TASK))).toEqual(TASK)
  })

  it('accepts a field a newer build added, which this one has no use for', () => {
    const newer = { v: 1, ...TASK, attempt: 2 }
    expect(readAgentSessionMessageSource(newer)).toEqual(TASK)
  })

  it("reads a message kind this build doesn't know as the person's, so the card is sent as written", () => {
    const unknownKind = { v: 1, ...TASK, orchestration: { message: 'review', dispatchId: 'ctx_1' } }
    expect(readAgentSessionMessageSource(unknownKind)).toBe(USER_MESSAGE_SOURCE)
  })
})
