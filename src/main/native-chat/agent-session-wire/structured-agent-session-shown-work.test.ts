import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionAgentStatus } from '../../../shared/structured-agent-session-agent-status'
import { projectStructuredAgentSessionStatusSummary } from '../../../shared/structured-agent-session-projection'
import { structuredAgentSessionShownStatus } from './structured-agent-session-shown-work'
import { childRecord, submission } from './structured-agent-session-restart-resume-test-harness'

describe('whether a session shows as working', () => {
  // The status feed scopes unanswered sends to the lease fence; a stale one would otherwise offer a
  // resume for a chat the sidebar showed idle.
  it('does not count a send left pending under an older lease fence', () => {
    const journal = { items: [], submissions: [submission('msg-1', 'pending')] }
    expect(structuredAgentSessionShownStatus(journal, undefined, 2).state).toBe('done')
    expect(structuredAgentSessionShownStatus(journal, undefined, 1).state).not.toBe('done')
  })

  it('counts a settled lead whose monitor still runs', () => {
    const journal = { items: [], submissions: [] }
    expect(
      structuredAgentSessionShownStatus(
        journal,
        [
          childRecord({
            id: 'watch',
            kind: 'monitor',
            description: 'Watch CI',
            state: 'monitoring'
          })
        ],
        1
      ).state
    ).not.toBe('done')
    expect(structuredAgentSessionShownStatus(journal, [], 1).state).toBe('done')
  })

  it("reads a subagent's request as the sidebar's fold does: the row waits, the main agent works", () => {
    const item = (itemId: string, sequence: number, body: AgentJournalRenderItem['body']) => ({
      itemId,
      sequence,
      revision: 1,
      observedAt: sequence,
      body
    })
    const items: AgentJournalRenderItem[] = [
      item('user', 1, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      item('turn', 2, { kind: 'turn', turnId: 't1', state: 'running', startedAt: 2 }),
      {
        ...item('ask', 3, {
          kind: 'approval',
          title: 'Run?',
          detail: null,
          options: [{ id: 'yes', label: 'Allow' }],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }),
        agentId: 'task-1'
      }
    ]
    const summary = projectStructuredAgentSessionStatusSummary(items, [], 1)
    for (const childWork of [
      [],
      [childRecord({ id: 'task-1', kind: 'agent', state: 'waiting' })]
    ]) {
      const shown = structuredAgentSessionShownStatus({ items, submissions: [] }, childWork, 1)
      expect(shown).toEqual(
        structuredAgentSessionAgentStatus({
          status: summary.status ?? 'idle',
          ...(summary.awaitsUserSince !== undefined
            ? { awaitsUserSince: summary.awaitsUserSince }
            : {}),
          childWork
        })
      )
      expect(shown).toMatchObject({ state: 'waiting', mainAgent: { state: 'working' } })
    }
  })
})
