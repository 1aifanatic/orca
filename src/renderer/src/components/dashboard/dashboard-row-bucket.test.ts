import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentMainAgentStatus } from '../../../../shared/main-agent-status'
import { dashboardRowBucketProjection } from './dashboard-row-bucket'

const PANE_KEY = 'tab-1:leaf-1'

function row(state: AgentStatusEntry['state'], mainAgent?: AgentMainAgentStatus) {
  const entry: AgentStatusEntry = {
    paneKey: PANE_KEY,
    state,
    prompt: 'do the thing',
    updatedAt: 2_000,
    stateStartedAt: 1_000,
    stateHistory: [],
    ...(mainAgent ? { mainAgent } : {})
  }
  return { paneKey: PANE_KEY, entry, state, startedAt: 1_000 }
}

describe('dashboardRowBucketProjection', () => {
  it('files a failed main agent under Done with its verdict while subagents work', () => {
    const projected = dashboardRowBucketProjection(
      row('working', { state: 'done', outcome: 'failure', stateStartedAt: 1_500 })
    )
    expect(projected).toMatchObject({ dotState: 'working', verdictMark: 'failed', bucket: 'done' })
  })

  it('keeps a seen user stop interrupted instead of settling it into idle', () => {
    const projected = dashboardRowBucketProjection(
      row('done', { state: 'done', outcome: 'cancellation', stateStartedAt: 1_000 }),
      { [PANE_KEY]: 5_000 }
    )
    expect(projected).toMatchObject({ unseen: false, verdictMark: 'interrupted', bucket: 'done' })
  })

  it('projects a row without a verdict exactly as before', () => {
    const projected = dashboardRowBucketProjection(row('done'), { [PANE_KEY]: 5_000 })
    expect(projected).toMatchObject({ verdictMark: undefined, bucket: 'idle' })
  })
})
