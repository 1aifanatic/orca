import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import { AGENT_SESSION_STATUS_AWAITS_USER_CAPABILITY } from '../../../../shared/agent-session-status-awaits-user-capability'
import type { StructuredAgentSessionStatusSubscriber } from '../../../native-chat/agent-session-wire/structured-agent-session-status-feed'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'
import { projectStatusAwaitsUserEvent } from './structured-agent-session-status-awaits-user-capability'

beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

const CURRENT_CLIENT = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: [
    ...STRUCTURED_CLIENT.clientCapabilities,
    AGENT_SESSION_STATUS_AWAITS_USER_CAPABILITY
  ]
}

/** The main agent runs its turn while a subagent waits on the user. */
const SUBAGENT_ASKS: AgentSessionStatusSummary = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  agent: 'claude',
  status: 'working',
  awaitsUser: true,
  latestPrompt: 'go',
  toolName: 'Task',
  statusStartedAt: 10,
  updatedAt: 20
}
/** What the host published for the same moment before the split. */
const PRE_SPLIT: AgentSessionStatusSummary = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  agent: 'claude',
  status: 'attention',
  awaitsUser: true,
  latestPrompt: 'go',
  updatedAt: 20
}

describe('awaitsUser capability at the status stream', () => {
  it.each([
    ['legacy reader', STRUCTURED_CLIENT, PRE_SPLIT],
    ['current reader', CURRENT_CLIENT, SUBAGENT_ASKS]
  ] as const)('publishes a subagent request to a %s', async (_label, client, expected) => {
    hostCalls.subscribeStatus.mockImplementation(
      (subscriber: StructuredAgentSessionStatusSubscriber) => {
        subscriber.emit({ type: 'snapshot', sessions: [SUBAGENT_ASKS] })
        return () => {}
      }
    )
    expect(await call('agentSession.subscribeStatus', null, client)).toMatchObject({
      ok: true,
      result: { type: 'snapshot', sessions: [expected] }
    })
  })
})

describe('awaitsUser projection', () => {
  const status: AgentSessionStatusEvent = { type: 'status', session: SUBAGENT_ASKS }

  it("reads a legacy reader `attention` for anyone's request, with the main agent's own fields gone", () => {
    expect(projectStatusAwaitsUserEvent(status, STRUCTURED_CLIENT)).toEqual({
      type: 'status',
      session: PRE_SPLIT
    })
    const idle = { ...SUBAGENT_ASKS, status: 'idle' as const, turnOutcome: 'success' as const }
    expect(
      projectStatusAwaitsUserEvent({ type: 'status', session: idle }, STRUCTURED_CLIENT)
    ).toEqual({ type: 'status', session: PRE_SPLIT })
  })

  it.each([
    ['capable client', CURRENT_CLIENT],
    ['in-process caller', {}]
  ] as const)('hands a %s the same object back', (_label, ctx) => {
    expect(projectStatusAwaitsUserEvent(status, ctx)).toBe(status)
  })

  it('returns the same object when nobody is asked', () => {
    const { awaitsUser: _awaitsUser, ...plain } = SUBAGENT_ASKS
    const event: AgentSessionStatusEvent = { type: 'snapshot', sessions: [plain, PRE_SPLIT] }
    expect(projectStatusAwaitsUserEvent(event, STRUCTURED_CLIENT)).toBe(event)
  })
})
