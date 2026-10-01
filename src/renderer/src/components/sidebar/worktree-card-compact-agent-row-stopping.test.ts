import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makeTab } from '../../store/slices/store-test-helpers'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import { getAgentDotState } from './worktree-card-agent-summary'
import { getCompactAgentSecondary } from './worktree-card-compact-agent-row'

const NOW = new Date('2026-05-04T12:00:00.000Z').getTime()
const TAB_ID = 'tab-1'

function row(mainAgent: AgentStatusEntry['mainAgent']) {
  const [agent] = buildWorktreeAgentRows({
    tabs: [makeTab({ id: TAB_ID, worktreeId: 'wt-1' })],
    entries: [
      {
        paneKey: `${TAB_ID}:11111111-1111-4111-8111-111111111111`,
        state: 'working',
        prompt: 'run the long build',
        toolName: 'Bash',
        toolInput: 'pnpm test',
        updatedAt: NOW,
        stateStartedAt: NOW,
        stateHistory: [],
        agentType: 'claude',
        mainAgent
      }
    ],
    retained: [],
    ptyIdsByTabId: { [TAB_ID]: ['pty-1'] },
    now: NOW
  })
  if (!agent) {
    throw new Error('expected one agent row')
  }
  return agent
}

describe("the sidebar row while a person's Stop ends the turn", () => {
  it('says Stopping in place of the last tool line, and keeps the working spinner', () => {
    const stopping = row({ state: 'working', stopping: true, stateStartedAt: NOW })

    expect(getCompactAgentSecondary(stopping, NOW)).toBe('Stopping…')
    expect(getAgentDotState(stopping)).toBe('working')
  })

  it('shows the tool line otherwise', () => {
    expect(getCompactAgentSecondary(row({ state: 'working', stateStartedAt: NOW }), NOW)).not.toBe(
      'Stopping…'
    )
  })
})
