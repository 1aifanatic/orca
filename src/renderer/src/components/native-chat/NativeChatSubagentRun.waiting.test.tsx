// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from '../../../../shared/agent-status-child-work-view'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentGroupBlock
} from '../../../../shared/native-chat-types'
import { NativeChatSubagentRun } from './NativeChatSubagentRun'
import { NativeChatSubagentSectionHead } from './NativeChatSubagentSectionHead'
import { NativeChatWaitingSubagentsProvider } from './NativeChatWaitingSubagentsProvider'
import { structuredSessionBackgroundTasksView } from './structured-session-background-tasks-view'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

afterEach(cleanup)

function group(agents: NativeChatSubagentEntry[]): NativeChatSubagentGroupBlock {
  return { type: 'subagent-group', groupId: 'tool:turn-1', agents }
}

/** A host child record, named by the task id the journal names the subagent by. */
function child(providerId: string, state: AgentChildWorkView['state']): AgentChildWorkView {
  const now = Date.now()
  return {
    id: `child-${providerId}`,
    providerId,
    kind: 'agent',
    description: providerId,
    state,
    membership: 'live',
    firstObservedAt: now - 1_000,
    observedAt: now,
    stoppable: false,
    invocation: { invocationId: `toolu-${providerId}`, generation: 1 }
  }
}

/** The strip's view of the session, as the transport hands it to the chat. */
function strip(children: AgentChildWorkView[]) {
  return structuredSessionBackgroundTasksView(
    { state: 'monitoring', tasks: [], children, supportsTaskStop: false },
    'turn-1'
  )
}

function renderWithHost(children: AgentChildWorkView[], ui: React.ReactNode) {
  return render(
    <NativeChatWaitingSubagentsProvider paneKey="pane-1" tasks={strip(children)}>
      {ui}
    </NativeChatWaitingSubagentsProvider>
  )
}

describe('the transcript subagent block beside the strip', () => {
  it('reads waiting while the host says the subagent waits on the user, as the strip does', () => {
    renderWithHost(
      [child('task-1', 'waiting')],
      <NativeChatSubagentRun block={group([{ id: 'task-1', label: 'touch', state: 'working' }])} />
    )
    const row = screen.getByRole('button')
    expect(row).toHaveTextContent('Kicked off 1 subagent')
    expect(row).toHaveTextContent('waiting')
    expect(row).not.toHaveTextContent('working')
    fireEvent.click(row)
    expect(screen.getByText('touch').parentElement).toHaveTextContent('waiting')
  })

  it('counts waiting beside the subagents still working', () => {
    renderWithHost(
      [child('task-1', 'waiting'), child('task-2', 'working')],
      <NativeChatSubagentRun
        block={group([
          { id: 'task-1', label: 'touch', state: 'working' },
          { id: 'task-2', label: 'read', state: 'working' }
        ])}
      />
    )
    expect(screen.getByRole('button')).toHaveTextContent('1 working +1 waiting')
  })

  it('goes back to the journal state once the host no longer reports the wait', () => {
    renderWithHost(
      [child('task-1', 'working')],
      <NativeChatSubagentRun block={group([{ id: 'task-1', label: 'touch', state: 'working' }])} />
    )
    expect(screen.getByRole('button')).toHaveTextContent('working')
    cleanup()
    renderWithHost(
      [],
      <NativeChatSubagentRun
        block={group([{ id: 'task-1', label: 'touch', state: 'completed', settledAt: 5 }])}
      />
    )
    expect(screen.getByRole('button')).toHaveTextContent('completed')
  })

  it('never reads a settled subagent waiting', () => {
    renderWithHost(
      [child('task-1', 'waiting')],
      <NativeChatSubagentRun
        block={group([{ id: 'task-1', label: 'touch', state: 'completed', settledAt: 5 }])}
      />
    )
    expect(screen.getByRole('button')).not.toHaveTextContent('waiting')
  })

  it("gives a subagent's section head the waiting dot too", () => {
    const { container } = renderWithHost(
      [child('task-1', 'waiting')],
      <NativeChatSubagentSectionHead
        agentId="task-1"
        entry={{ id: 'task-1', label: 'touch', state: 'working' }}
        expanded={false}
        onSetOpen={() => {}}
      />
    )
    expect(container.querySelector('.bg-agent-question')).not.toBeNull()
  })
})
