import { beforeAll, describe, expect, it } from 'vitest'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionStatusSummary } from '../../../src/shared/agent-session-wire'
import { projectStructuredAgentSessionStatusSummary } from '../../../src/shared/structured-agent-session-projection'
import { projectStatusAwaitsUserEvent } from '../../../src/main/runtime/rpc/methods/structured-agent-session-status-awaits-user-capability'

/**
 * A summary's `status` became the main agent's own, with `awaitsUserSince` carrying anyone's
 * request. A client that predates the split is sent the downgraded summary, whose fields the split
 * touches must read as a pre-split host projected them from the same journal, clock included
 * (Rule 3). Only those fields are compared, so an additive field elsewhere (Rule 1) stays green.
 *
 * Pinned rather than derived from the newest tag: once a release ships the split, that release
 * no longer projects the pre-split summary this compares against.
 */
const PRE_SPLIT_REF = 'v1.4.218'
const SUITE_TIMEOUT_MS = 180_000
const OLD_CLIENT = { clientKind: 'runtime' as const, clientCapabilities: [] }

type Projection = (items: readonly AgentJournalRenderItem[]) => Record<string, unknown>
let preSplitProjection: Projection

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(PRE_SPLIT_REF)
  const projection = await importReleaseCheckoutModule(
    checkout,
    'src/shared/structured-agent-session-projection.ts'
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release exports this projection under this name; a missing one fails the test.
  preSplitProjection = (projection as { projectStructuredAgentSessionStatusSummary: Projection })
    .projectStructuredAgentSessionStatusSummary
}, SUITE_TIMEOUT_MS)

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body'],
  agentId?: string
): AgentJournalRenderItem {
  return {
    itemId,
    sequence,
    revision: 1,
    observedAt: sequence * 100,
    body,
    ...(agentId ? { agentId } : {})
  }
}

const user = item('user', 1, {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'go' }]
})
const running = item('running', 2, { kind: 'turn', turnId: 't1', state: 'running', startedAt: 150 })
const settled = item('settled', 2, {
  kind: 'turn',
  turnId: 't1',
  state: 'completed',
  outcome: 'success',
  startedAt: 150,
  completedAt: 250
})
const tool = item('tool', 3, {
  kind: 'tool-call',
  toolCallId: 'c1',
  name: 'Task',
  input: { description: 'review' },
  state: 'running'
})
const reply = item('reply', 4, {
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'on it' }]
})
const pending: AgentJournalRenderItem['body'] = {
  kind: 'approval',
  title: 'Run?',
  detail: null,
  options: [{ id: 'y', label: 'Allow' }],
  resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
}
const subagentAsk = item('subagent-ask', 5, pending, 'task-1')
const ownAsk = item('own-ask', 6, pending)

/** The summary fields the split changes the meaning or presence of. */
function splitOwnedFields(summary: Record<string, unknown>): Record<string, unknown> {
  return {
    status: summary.status,
    statusStartedAt: summary.statusStartedAt,
    toolName: summary.toolName,
    toolInput: summary.toolInput,
    turnOutcome: summary.turnOutcome,
    hasAwaitsUserSince: 'awaitsUserSince' in summary
  }
}

/** What a client without the capability is sent for this journal. */
function downgraded(items: readonly AgentJournalRenderItem[]): Record<string, unknown> {
  const session: AgentSessionStatusSummary = {
    sessionId: 's',
    workspaceId: 'w',
    agent: 'claude',
    ...projectStructuredAgentSessionStatusSummary(items),
    updatedAt: 1
  }
  const event = projectStatusAwaitsUserEvent({ type: 'status', session }, OLD_CLIENT)
  if (event.type !== 'status') {
    throw new Error('the downgrade changed the event')
  }
  const { sessionId: _s, workspaceId: _w, agent: _a, updatedAt: _u, ...summary } = event.session
  return summary
}

describe('an old client against a host that splits the main agent from awaitsUserSince', () => {
  it.each([
    ['a subagent asks while the main agent works', [user, running, tool, reply, subagentAsk]],
    ['a subagent asks after the main agent settled', [user, settled, reply, subagentAsk]],
    ['the main agent asks', [user, running, tool, ownAsk]],
    ['both ask', [user, running, tool, subagentAsk, ownAsk]],
    ['nobody asks, working', [user, running, tool, reply]],
    ['nobody asks, settled', [user, settled, reply]]
  ])('is sent what the pre-split host published when %s', (_label, items) => {
    expect(splitOwnedFields(downgraded(items))).toEqual(splitOwnedFields(preSplitProjection(items)))
  })
})
