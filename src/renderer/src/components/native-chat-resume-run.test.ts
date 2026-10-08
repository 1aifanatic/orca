import { describe, expect, it } from 'vitest'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import { beginResumeRun, resumeRunInFlight, resumeRunPendingIds } from './native-chat-resume-run'
import { resumeRunView } from './native-chat-resume-run-view'
import type { ResumeRunHostStatus } from './use-resume-run-status-feed'

const row = (sessionId: string): ResumeCandidate => ({
  sessionId,
  workspaceId: 'folder',
  agent: 'codex',
  trigger: 'quit',
  latestPrompt: `Prompt ${sessionId}`,
  recordedAt: 1
})
const failure = { ...row('a'), failedAt: 2, outcome: 'unconfirmed' as const, reason: 'pending' }
const run = beginResumeRun([row('a'), row('b')], 10)

describe('the dialog over a bulk action', () => {
  it('settles a chat from its host verdict while the request remains in flight', () => {
    const statusFor = (id: string): ResumeRunHostStatus => ({
      restartResume: { phase: id === 'a' ? 'continued' : 'queued' }
    })
    const view = resumeRunView(run, [], () => undefined, 'all', statusFor)
    expect(view.rows.map((entry) => entry.sessionId)).toEqual(['b', 'a'])
    expect(view.statusBySession.get('a')).toEqual({ kind: 'resumed' })
    expect(view.counts).toMatchObject({ total: 2, done: 1, resumed: 1, inProgress: 1 })
    expect(resumeRunInFlight(run)).toBe(true)
    expect(resumeRunPendingIds(run)).toEqual(['a', 'b'])
  })

  it('degrades an older host to waiting until the reply, even if its ordinary status is ready', () => {
    const view = resumeRunView(
      run,
      [],
      () => undefined,
      'all',
      () => ({ hostExecutionPhase: 'ready' })
    )
    expect(view.counts.inProgress).toBe(2)
    expect(view.statusBySession.get('a')).toEqual({ kind: 'in-flight', phase: null, startedAt: 10 })
  })

  it('distinguishes waiting for a start slot from holding one and waiting for delivery', () => {
    for (const hostExecutionPhase of ['starting', 'ready'] as const) {
      const view = resumeRunView(
        run,
        [],
        () => undefined,
        'all',
        () => ({ restartResume: { phase: 'starting' }, hostExecutionPhase })
      )
      expect(view.statusBySession.get('a')).toEqual({
        kind: 'in-flight',
        phase: hostExecutionPhase,
        startedAt: 10
      })
    }
  })

  it('a retry shows its current progress over the previous failure', () => {
    const view = resumeRunView(run, [failure], () => failure, 'all')
    expect(view.counts.attention).toBe(0)
    expect(view.statusBySession.get('a')?.kind).toBe('in-flight')
  })

  it('withdrawn and dismissed failures leave Need you after the reply', () => {
    const finished = {
      ...run,
      inFlight: false,
      continued: [{ sessionId: 'a', outcome: 'unknown' as const }]
    }
    const failed = resumeRunView(
      finished,
      [failure],
      (id) => (id === 'a' ? failure : undefined),
      'attention'
    )
    expect(failed.rows).toEqual([failure])
    const withdrawn = resumeRunView(finished, [], () => undefined, 'attention')
    expect(withdrawn.rows).toEqual([])
    expect(withdrawn.counts.attention).toBe(0)
  })

  it('retains successful history but always shows current host failures', () => {
    const finished = {
      ...run,
      inFlight: false,
      continued: [{ sessionId: 'a', outcome: 'continued' as const }]
    }
    expect(resumeRunView(finished, [], () => undefined, 'resumed').rows).toEqual([row('a')])
    const failed = resumeRunView(
      finished,
      [failure],
      (id) => (id === 'a' ? failure : undefined),
      'attention'
    )
    expect(failed.rows).toEqual([failure])
    expect(failed.statusBySession.has('a')).toBe(false)
    expect(resumeRunPendingIds(finished)).toBe(resumeRunPendingIds(null))
  })

  it('shows final per-chat failures from the feed before the batch returns', () => {
    for (const phase of ['refused', 'unconfirmed'] as const) {
      const view = resumeRunView(
        run,
        [],
        () => undefined,
        'attention',
        () => ({ restartResume: { phase } })
      )
      expect(view.counts.attention).toBe(2)
      expect(view.statusBySession.get('a')).toEqual({ kind: phase })
    }
  })
})
