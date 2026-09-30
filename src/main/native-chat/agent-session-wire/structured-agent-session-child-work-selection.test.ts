// What each surface lists of a session's child records: the sidebar its running children, the
// chat's strip every running child and then the newest finished ones, up to 100 rows.

import { describe, expect, it } from 'vitest'
import { buildAgentChildRowModels } from '../../../shared/agent-child-row-model'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import {
  STRUCTURED_STRIP_CHILD_WORK_LIMIT as LIMIT,
  structuredSidebarChildWork,
  structuredStripChildWork
} from '../../../shared/agent-child-work-listing'
import {
  attach,
  hostTestState,
  serveHostTestChildWork
} from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

function running(id: string, over: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  return {
    id,
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 1,
    observedAt: 1,
    stoppable: false,
    invocation: { invocationId: `spawn-${id}`, generation: 1 },
    ...over
  }
}

function finished(id: string, settledAt: number): AgentChildWorkView {
  return running(id, {
    state: 'done',
    membership: 'settled',
    outcome: 'succeeded',
    observedAt: settledAt,
    settledAt
  })
}

const ids = (views: readonly AgentChildWorkView[]) => views.map((view) => view.id)

describe('the sidebar lists running children only', () => {
  it('drops finished and failed children, and keeps a finished one whose shell still runs', () => {
    const failed = { ...finished('failed', 5), outcome: 'failed' as const }
    const views = [
      running('working'),
      finished('done', 4),
      failed,
      finished('owner', 3),
      running('shell', { kind: 'command', parentChildWorkId: 'owner' })
    ]
    expect(ids(structuredSidebarChildWork(views))).toEqual(['working', 'owner', 'shell'])
  })
})

describe('the strip lists running children, then the newest finished, up to 100 rows', () => {
  it('renders every row it keeps: a child whose owner the budget cut belongs to the main agent', () => {
    const views = [
      ...Array.from({ length: LIMIT - 2 }, (_, index) => running(`run-${index}`)),
      finished('owner', 10),
      { ...finished('nested', 200), parentChildWorkId: 'owner' },
      finished('newest', 300)
    ]
    const strip = structuredStripChildWork(views)
    expect(strip).toHaveLength(LIMIT)
    expect(ids(strip)).not.toContain('owner')
    expect(strip.find((view) => view.id === 'nested')).not.toHaveProperty('parentChildWorkId')
    const rows = buildAgentChildRowModels(strip, {
      parentEvidenceFresh: true,
      transportObservation: 'live',
      parentObservedAt: 1,
      hostClockOffsetMs: 0
    })
    const rendered = (models: typeof rows): string[] =>
      models.flatMap((model) => [model.id, ...rendered(model.owned)])
    expect(rendered(rows)).toHaveLength(LIMIT)
  })

  it('lists every child while they fit', () => {
    const views = [running('a'), finished('b', 2), finished('c', 3)]
    expect(ids(structuredStripChildWork(views))).toEqual(['a', 'b', 'c'])
  })

  it('keeps every running child and the newest finished ones, in the order the store holds them', () => {
    const finishedViews = Array.from({ length: 150 }, (_, index) =>
      finished(`done-${index}`, 1_000 + index)
    )
    const runningViews = Array.from({ length: 10 }, (_, index) => running(`run-${index}`))
    const listed = structuredStripChildWork([...finishedViews, ...runningViews])
    expect(listed).toHaveLength(LIMIT)
    // The 90 newest finished children (settled latest), then the running ones, as the store orders.
    expect(ids(listed)).toEqual([
      ...Array.from({ length: 90 }, (_, index) => `done-${index + 60}`),
      ...ids(runningViews)
    ])
  })

  it('shows every running child when more than 100 run, and no finished one', () => {
    const runningViews = Array.from({ length: 120 }, (_, index) => running(`run-${index}`))
    const listed = structuredStripChildWork([finished('done', 5), ...runningViews])
    expect(ids(listed)).toEqual(ids(runningViews))
  })
})

describe("the host's strip channel and summary list what these pick", () => {
  it('sends the strip the bounded roster and the sidebar the running children', async () => {
    const records = [
      ...Array.from({ length: 150 }, (_, index) => finished(`done-${index}`, 1_000 + index)),
      running('run')
    ]
    serveHostTestChildWork(() => records)
    await attach()
    const { host } = hostTestState()
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    const children = page.ok ? (page.page.backgroundTasks?.children ?? []) : []
    expect(children).toHaveLength(LIMIT)
    expect(children.at(-1)?.id).toBe('run')
    expect(children[0]?.id).toBe('done-51')
    const summaries: string[][] = []
    host.subscribeStatus({
      id: 'list',
      emit: (event) => {
        if (event.type === 'snapshot') {
          summaries.push(event.sessions.flatMap((session) => ids(session.children ?? [])))
        }
      }
    })
    expect(summaries.at(-1)).toEqual(['run'])
  })
})
