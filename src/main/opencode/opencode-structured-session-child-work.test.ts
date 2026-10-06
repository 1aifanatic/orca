import { describe, expect, it } from 'vitest'
import { OpenCodeTimelineTranslator } from './serve/timeline-translator'
import { openCodeChildWorkEvidence } from './opencode-structured-session-child-work'

describe('OpenCode child work evidence', () => {
  it('settles a child on its own idle and reports later work as a restart', () => {
    const translator = new OpenCodeTimelineTranslator({ sessionId: 'root', major: 1 })
    translator.registerSession({ id: 'child', parentID: 'root', title: 'Research' })
    const session = { translator, root: { id: 'root' }, childActive: new Set<string>() }
    const created = openCodeChildWorkEvidence(
      session,
      { type: 'session.created', data: { sessionID: 'child' } },
      new Set(['root']),
      'child'
    )
    expect(created).toMatchObject([
      { type: 'live', child: { handle: { id: 'child' }, state: 'idle' } }
    ])
    expect(session.childActive.size).toBe(0)
    openCodeChildWorkEvidence(
      session,
      {
        type: 'session.status',
        data: { sessionID: 'child', status: { type: 'busy' } }
      },
      new Set(['root', 'child']),
      'child'
    )
    const idle = openCodeChildWorkEvidence(
      session,
      { type: 'session.idle', data: { sessionID: 'child' } },
      new Set(['root', 'child']),
      'child'
    )
    expect(idle).toMatchObject([{ type: 'ended', outcome: 'succeeded' }])
    const restarted = openCodeChildWorkEvidence(
      session,
      { type: 'message.updated', data: { sessionID: 'child' } },
      new Set(['root', 'child']),
      'child'
    )
    expect(restarted).toMatchObject([{ type: 'live', restart: true }])
  })

  it('does not report a session outside the root ancestry', () => {
    const translator = new OpenCodeTimelineTranslator({ sessionId: 'root', major: 2 })
    const session = { translator, root: { id: 'root' }, childActive: new Set<string>() }
    expect(
      openCodeChildWorkEvidence(
        session,
        { type: 'session.execution.started', data: { sessionID: 'other' } },
        new Set(['root']),
        'other'
      )
    ).toEqual([])
  })
})
