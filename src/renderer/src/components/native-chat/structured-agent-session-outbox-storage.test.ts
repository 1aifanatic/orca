// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  hasUndeliveredStructuredAgentSessionOutbox,
  appendStructuredAgentSessionOutboxMessage,
  getStructuredAgentSessionOutbox,
  readOutbox,
  resetUndeliveredStructuredAgentSessionOutboxForTests,
  subscribeToStructuredAgentSessionOutbox,
  subscribeToUndeliveredStructuredAgentSessionOutbox,
  writeOutbox
} from './structured-agent-session-outbox-storage'

function entry(sessionId: string, clientMessageId: string) {
  return createStructuredAgentSessionOutboxEntry({
    clientMessageId,
    sessionId,
    text: clientMessageId,
    attachments: [],
    queuedAt: 1
  })
}

describe('undelivered structured agent session outbox projection', () => {
  beforeEach(() => {
    localStorage.clear()
    resetUndeliveredStructuredAgentSessionOutboxForTests()
  })

  it('reports a session whose outbox was persisted before this renderer read it', () => {
    writeOutbox('session-a', [entry('session-a', 'client-1')])
    resetUndeliveredStructuredAgentSessionOutboxForTests()

    expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(true)
    expect(hasUndeliveredStructuredAgentSessionOutbox('session-b')).toBe(false)
  })

  it('notifies when the first entry lands and when the last one leaves', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', listener)

    writeOutbox('session-a', [entry('session-a', 'client-1')])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(true)

    writeOutbox('session-a', [])
    expect(listener).toHaveBeenCalledTimes(2)
    expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(false)

    unsubscribe()
    writeOutbox('session-a', [entry('session-a', 'client-2')])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stays quiet for a write that leaves the session undelivered either way', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', listener)

    writeOutbox('session-a', [entry('session-a', 'client-1'), entry('session-a', 'client-2')])
    expect(listener).toHaveBeenCalledTimes(1)

    writeOutbox('session-a', [entry('session-a', 'client-2')])
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
  it('does not notify a session subscriber for another session', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', listener)
    expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(false)
    writeOutbox('session-b', [entry('session-b', 'client-1')])
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('releases the cached snapshot when the last subscriber leaves', () => {
    writeOutbox('session-a', [entry('session-a', 'client-1')])
    const unsubscribe = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', vi.fn())
    const getItem = vi.spyOn(localStorage, 'getItem')
    for (let index = 0; index < 10; index += 1) {
      expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(true)
    }
    expect(getItem).not.toHaveBeenCalled()
    unsubscribe()
    localStorage.clear()
    expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(false)
    getItem.mockRestore()
  })

  it('keeps a snapshot until both subscribers leave and reloads it on remount', () => {
    const first = vi.fn()
    const second = vi.fn()
    const releaseFirst = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', first)
    const releaseSecond = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', second)
    releaseFirst()
    writeOutbox('session-a', [entry('session-a', 'client-1')])
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    releaseSecond()
    localStorage.clear()
    const releaseRemount = subscribeToUndeliveredStructuredAgentSessionOutbox('session-a', first)
    expect(hasUndeliveredStructuredAgentSessionOutbox('session-a')).toBe(false)
    writeOutbox('session-a', [entry('session-a', 'client-2')])
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    releaseRemount()
  })
})

describe('a message an older build saved', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // Each one was held for a Retry this build no longer has: never sent again on its own.
  it.each([
    ['rejected', { state: 'rejected', lastFailure: { kind: 'rejected', reason: 'Nope.' } }],
    ['held for its Retry', { lastFailure: { kind: 'refused', code: 'agent_session_conflict' } }],
    ['held for a Retry with a failure this build cannot read', { lastFailure: 'restarting' }],
    ['outlived by a Stop', { state: 'unconfirmed', lastAttemptAt: 2, outlivedStop: true }]
  ])('reads back one %s as waiting for its settlement', (_label, saved) => {
    localStorage.setItem(
      'orca:desktopStructuredAgentSessionOutbox:v1:session-a',
      JSON.stringify([{ ...entry('session-a', 'client-1'), ...saved }])
    )
    expect(readOutbox('session-a')).toMatchObject([
      { clientMessageId: 'client-1', legacyUnsettled: true }
    ])
    expect(readOutbox('session-a')[0]).not.toHaveProperty('lastFailure')
  })

  it("reads back a Stop's stamp with its answer, and drops a malformed one", () => {
    writeOutbox('session-a', [
      {
        ...entry('session-a', 'client-1'),
        stoppedBy: { operationId: 'stop-1', cursor: { epoch: 'e', sequence: 4 } }
      },
      {
        ...entry('session-a', 'client-2'),
        stoppedBy: { operationId: 'stop-2', unanswerable: true }
      }
    ])
    localStorage.setItem(
      'orca:desktopStructuredAgentSessionOutbox:v1:session-b',
      JSON.stringify([{ ...entry('session-b', 'client-3'), stoppedBy: { cursor: 4 } }])
    )
    expect(readOutbox('session-a').map((saved) => saved.stoppedBy)).toEqual([
      { operationId: 'stop-1', cursor: { epoch: 'e', sequence: 4 } },
      { operationId: 'stop-2', unanswerable: true }
    ])
    expect(readOutbox('session-b')[0]).not.toHaveProperty('stoppedBy')
  })
})

describe('the session outbox store', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows an open chat a message queued from elsewhere', () => {
    const listener = vi.fn()
    const release = subscribeToStructuredAgentSessionOutbox('session-1', () => [], listener)

    const queued = appendStructuredAgentSessionOutboxMessage('session-1', 'review notes')

    expect(listener).toHaveBeenCalledOnce()
    expect(getStructuredAgentSessionOutbox('session-1')).toEqual([queued])
    expect(readOutbox('session-1')).toEqual([queued])
    release()
  })

  it('queues behind an in-flight send without disturbing it', () => {
    writeOutbox('session-1', [{ ...entry('session-1', 'in-flight'), state: 'dispatching' }])

    appendStructuredAgentSessionOutboxMessage('session-1', 'review notes')

    expect(readOutbox('session-1', { recoverDispatching: false }).map((e) => e.state)).toEqual([
      'dispatching',
      'queued'
    ])
  })

  it('keeps the open outbox when a required save fails', () => {
    const release = subscribeToStructuredAgentSessionOutbox('session-1', () => [], vi.fn())
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })

    expect(appendStructuredAgentSessionOutboxMessage('session-1', 'review notes')).toBeNull()
    expect(getStructuredAgentSessionOutbox('session-1')).toEqual([])
    setItem.mockRestore()
    release()
  })

  it('releases the held copy with its last subscriber', () => {
    const release = subscribeToStructuredAgentSessionOutbox(
      'session-1',
      () => [{ ...entry('session-1', 'loaded'), state: 'unconfirmed' }],
      vi.fn()
    )
    expect(getStructuredAgentSessionOutbox('session-1')[0]?.state).toBe('unconfirmed')

    release()

    expect(getStructuredAgentSessionOutbox('session-1')).toEqual([])
  })
})
