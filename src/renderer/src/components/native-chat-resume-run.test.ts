import { describe, expect, it } from 'vitest'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import {
  beginResumeRunEntries,
  resumeRunInFlight,
  resumeRunPendingIds,
  resumeRunResultOf,
  settleResumeRunEntry
} from './native-chat-resume-run'
import { resumeRunView } from './native-chat-resume-run-view'

const row = (sessionId: string): ResumeCandidate => ({
  sessionId,
  workspaceId: 'workspace',
  agent: 'codex',
  trigger: 'quit',
  latestPrompt: `Prompt ${sessionId}`,
  recordedAt: 1
})

const refused = (sessionId: string) => ({
  ...row(sessionId),
  failedAt: 2,
  outcome: 'refused' as const,
  reason: 'agent_session_conflict'
})

describe('a run', () => {
  it('settles each chat on its own answer and keeps the order the chats were asked in', () => {
    let run = beginResumeRunEntries(null, [row('a'), row('b')], 10)
    expect(resumeRunPendingIds(run)).toEqual(['a', 'b'])
    run = settleResumeRunEntry(run, 'b', 'resumed')!
    expect(resumeRunPendingIds(run)).toEqual(['a'])
    expect(resumeRunInFlight(run)).toBe(true)
    run = settleResumeRunEntry(run, 'a', 'refused')!
    expect(resumeRunInFlight(run)).toBe(false)
    expect(run.entries.map((entry) => [entry.candidate.sessionId, entry.result])).toEqual([
      ['a', 'refused'],
      ['b', 'resumed']
    ])
  })

  // A retry while the run still moves joins it; one after it finished starts a fresh run.
  it('joins a run in flight and replaces a finished one', () => {
    const moving = beginResumeRunEntries(null, [row('a'), row('b')], 10)
    const joined = beginResumeRunEntries(
      settleResumeRunEntry(moving, 'a', 'refused'),
      [row('a')],
      20
    )
    expect(joined.startedAt).toBe(10)
    expect(joined.entries.map((entry) => [entry.candidate.sessionId, entry.result])).toEqual([
      ['b', undefined],
      ['a', undefined]
    ])

    const finished = settleResumeRunEntry(
      settleResumeRunEntry(moving, 'a', 'resumed'),
      'b',
      'resumed'
    )
    const fresh = beginResumeRunEntries(finished, [row('c')], 30)
    expect(fresh).toEqual({ startedAt: 30, entries: [{ candidate: row('c'), startedAt: 30 }] })
  })

  it('shares one empty pending list, so readers of it do not re-render for nothing', () => {
    expect(resumeRunPendingIds(null)).toBe(resumeRunPendingIds(null))
  })
})

describe("one chat's answer", () => {
  it.each([
    ['continued', undefined, 'resumed'],
    ['refused', undefined, 'refused'],
    ['unknown', undefined, 'unconfirmed'],
    // With the host's list read, an unconfirmed send it no longer lists was seen carrying on.
    ['unknown', [], 'resumed'],
    // A refusal the host no longer lists: the user answered first, and nothing failed.
    ['refused', [], 'gone']
  ] as const)('reads %s with failures %j as %s', (outcome, failed, result) => {
    expect(resumeRunResultOf('a', [{ sessionId: 'a', outcome }], failed)).toBe(result)
  })

  it('prefers what the host lists the chat as', () => {
    expect(
      resumeRunResultOf(
        'a',
        [{ sessionId: 'a', outcome: 'continued' }],
        [{ sessionId: 'a', outcome: 'unconfirmed' }]
      )
    ).toBe('unconfirmed')
  })

  it('treats an answer without outcomes as unconfirmed, and one that skipped the chat as gone', () => {
    expect(resumeRunResultOf('a', undefined, undefined)).toBe('unconfirmed')
    expect(resumeRunResultOf('a', [], [])).toBe('gone')
  })
})

describe('the dialog over a run', () => {
  const run = (() => {
    let next = beginResumeRunEntries(null, [row('a'), row('b'), row('c'), row('d')], 10)
    next = settleResumeRunEntry(next, 'a', 'resumed')!
    next = settleResumeRunEntry(next, 'c', 'refused')!
    return settleResumeRunEntry(next, 'd', 'gone')!
  })()

  it('lists what needs the user first, then what is moving, then what is done', () => {
    const view = resumeRunView(run, [row('e')], () => undefined, 'all')
    expect(view.rows.map((entry) => entry.sessionId)).toEqual(['c', 'b', 'a', 'e'])
    expect(view.counts).toEqual({
      all: 4,
      total: 3,
      done: 2,
      inProgress: 1,
      resumed: 1,
      attention: 1
    })
    expect(view.statusBySession.get('b')).toEqual({ kind: 'in-flight', startedAt: 10 })
    expect(view.statusBySession.get('c')).toEqual({ kind: 'refused' })
    // A chat nobody needed resuming is left out rather than shown as resumed.
    expect(view.statusBySession.has('d')).toBe(false)
  })

  // Once the host lists the failure, its row is the failure row with guidance, not a bare icon.
  it('shows a failure the host lists as its failure row', () => {
    const view = resumeRunView(
      run,
      [refused('c')],
      (sessionId) => (sessionId === 'c' ? refused('c') : undefined),
      'all'
    )
    expect(view.statusBySession.has('c')).toBe(false)
    expect(view.rows.map((entry) => entry.sessionId)).toEqual(['c', 'b', 'a'])
  })

  it.each([
    ['in-progress', ['b']],
    ['resumed', ['a']],
    ['attention', ['c']]
  ] as const)('narrows the list to %s', (filter, ids) => {
    expect(
      resumeRunView(run, [], () => undefined, filter).rows.map((entry) => entry.sessionId)
    ).toEqual(ids)
  })
})
