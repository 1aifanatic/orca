// Each chat's status is saved where a restart can read it, on the edges a restart would show and
// never per streamed delta.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { StructuredAgentSessionStatusOwnership } from './structured-agent-session-status-ownership'

const location: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'folder-workspace',
  workspaceKind: 'folder'
}
const working: AgentSessionStatusSummary = {
  sessionId: 'structured-session',
  workspaceId: location.workspaceId,
  agent: 'codex',
  status: 'working',
  latestPrompt: 'fix the flaky test',
  hostExecutionOwned: true,
  hostExecutionPhase: 'ready',
  toolName: 'Bash',
  toolInput: 'pnpm test',
  stopping: true,
  children: [],
  backgroundTasks: [],
  lastAssistantMessage: 'Looking at it',
  updatedAt: 100
}

function owner() {
  const sink = { publish: vi.fn(), forget: vi.fn(), saveStatus: vi.fn(), dropSavedStatus: vi.fn() }
  return { sink, owner: new StructuredAgentSessionStatusOwnership(() => sink) }
}

describe('saving a chat status for the next launch', () => {
  it('saves only what outlives the host, with the fence of the child running the turn', () => {
    const { sink, owner: status } = owner()

    status.publish(working, location, 3)

    expect(sink.saveStatus).toHaveBeenCalledExactlyOnceWith({
      summary: {
        sessionId: working.sessionId,
        workspaceId: working.workspaceId,
        agent: 'codex',
        status: 'working',
        latestPrompt: 'fix the flaky test',
        lastAssistantMessage: 'Looking at it',
        updatedAt: 100
      },
      turnFence: 3
    })
  })

  it('saves on each status or verdict edge, and not for a streamed delta', () => {
    const { sink, owner: status } = owner()
    status.publish(working, location, 3)
    status.publish(
      { ...working, lastAssistantMessage: 'Found it', toolName: 'Edit', updatedAt: 140 },
      location,
      3
    )
    status.publish({ ...working, updatedAt: 150, toolInput: 'pnpm lint' }, location, 3)
    expect(sink.saveStatus).toHaveBeenCalledOnce()

    const idle = { ...working, status: 'idle' as const, turnOutcome: 'success' as const }
    status.publish(idle, location, 3)
    status.publish({ ...idle, lastAssistantMessage: 'Done', updatedAt: 200 }, location, 3)
    status.publish({ ...idle, turnOutcome: 'failure' }, location, 3)

    expect(sink.saveStatus.mock.calls.map(([saved]) => saved)).toEqual([
      expect.objectContaining({ summary: expect.objectContaining({ status: 'working' }) }),
      { summary: expect.objectContaining({ status: 'idle', turnOutcome: 'success' }) },
      { summary: expect.objectContaining({ status: 'idle', turnOutcome: 'failure' }) }
    ])
  })

  it('saves again when another child takes over the running turn', () => {
    const { sink, owner: status } = owner()
    status.publish({ ...working, status: 'attention' }, location, 3)
    status.publish({ ...working, status: 'attention' }, location, 4)

    expect(sink.saveStatus.mock.calls.map(([saved]) => saved.turnFence)).toEqual([3, 4])
  })

  it('lets the saved status die with the address when the host lets go of the chat', () => {
    const { sink, owner: status } = owner()
    status.publish(working, location, 3)

    status.forget(working.sessionId)

    expect(sink.dropSavedStatus).toHaveBeenCalledExactlyOnceWith(working.sessionId)
    // A later publish under the same address is a new first save, not an unchanged one.
    status.publish(working, location, 3)
    expect(sink.saveStatus).toHaveBeenCalledTimes(2)
  })
})
