import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import {
  projectStructuredAgentSessionStatus,
  projectStructuredAgentSessionStatusSummary,
  structuredAgentSessionAwaitsUser
} from './structured-agent-session-projection'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: sequence, body }
}

describe("a subagent's prompt in the session's status", () => {
  it("reads the session's own status past a subagent's prompt, while a human is still asked", () => {
    const user = item('user', 1, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'go' }]
    })
    const running = item('running', 2, {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId: 'turn-1', state: 'running' }
    })
    const pending = {
      kind: 'approval' as const,
      title: 'Run command?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: {
        state: 'pending' as const,
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    }
    const childPrompt = { ...item('child-prompt', 3, pending), agentId: 'task-1' }
    const ownPrompt = item('own-prompt', 4, pending)

    // Someone has to answer either way; only the session's own prompt is the session waiting.
    expect(structuredAgentSessionAwaitsUser([running, childPrompt])).toBe(true)
    expect(structuredAgentSessionAwaitsUser([running])).toBe(false)
    expect(projectStructuredAgentSessionStatus([running, childPrompt])).toBe('working')
    expect(projectStructuredAgentSessionStatusSummary([user, running, childPrompt])).toMatchObject({
      status: 'working',
      awaitsUser: true
    })
    expect(projectStructuredAgentSessionStatusSummary([user, childPrompt])).toMatchObject({
      status: 'idle',
      awaitsUser: true
    })
    expect(
      projectStructuredAgentSessionStatusSummary([user, running, childPrompt, ownPrompt])
    ).toMatchObject({ status: 'attention', awaitsUser: true })
    expect(projectStructuredAgentSessionStatusSummary([user, running])).not.toHaveProperty(
      'awaitsUser'
    )
  })
})
