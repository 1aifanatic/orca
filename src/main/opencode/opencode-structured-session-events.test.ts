import { afterEach, expect, it, vi } from 'vitest'
import { OpenCodeStructuredSessionEvents } from './opencode-structured-session-events'
import { openCodeSessionTestFixture } from './opencode-structured-session-test-fixture'
import { proveOpenCodeSessionAncestry } from './opencode-structured-session-ancestry'

afterEach(() => vi.useRealTimers())

it('re-derives each ancestry chain after a transient native lookup failure', async () => {
  vi.useFakeTimers()
  let reads = 0
  const fetchImpl = vi.fn<typeof fetch>(async (url, options) => {
    if (options?.method === 'PATCH') {
      return new Response(null, { status: 204 })
    }
    reads += 1
    return reads === 1
      ? new Response(null, { status: 503 })
      : Response.json({ id: new URL(String(url)).pathname.split('/').at(-1), parentID: 'root' })
  })
  const { session } = openCodeSessionTestFixture(1, fetchImpl)
  const first = proveOpenCodeSessionAncestry(session, 'child-first', () => true)
  await vi.advanceTimersByTimeAsync(250)
  expect(await first).toBe(true)
  for (let index = 0; index < 65; index += 1) {
    expect(await proveOpenCodeSessionAncestry(session, `child-${index}`, () => true)).toBe(true)
  }
  expect(session.translator?.ownsSession('child-64')).toBe(true)
  session.connection.peer.close()
})

it('does not publish a child after its generation closes during lookup', async () => {
  let release = (_response: Response): void => {}
  const fetchImpl = vi.fn<typeof fetch>(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const { session, sessions } = openCodeSessionTestFixture(2, fetchImpl)
  const evidence = vi.fn()
  const events = new OpenCodeStructuredSessionEvents(sessions, {
    resolveLaunch: async () => session.launch,
    onChildWorkEvidence: evidence
  })
  const frame = events.onFrame(session, {
    type: 'permission.asked',
    data: { sessionID: 'child', id: 'ask', action: 'shell' }
  })
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
  session.ended = true
  release(Response.json({ data: { id: 'child', parentID: 'root' } }))
  await frame
  expect(evidence).not.toHaveBeenCalled()
  expect(session.pending.size).toBe(0)
  session.connection.peer.close()
})

it('keeps buffered and new permission events in one ordered queue', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}))
  const { session, sessions } = openCodeSessionTestFixture(1, fetchImpl)
  session.ready = false
  const events = new OpenCodeStructuredSessionEvents(sessions, {
    resolveLaunch: async () => session.launch
  })
  const ask = (id: string) => ({
    type: 'permission.asked',
    data: { sessionID: 'root', id, permission: 'bash', patterns: ['echo ok'] }
  })
  await events.onFrame(session, ask('first'))
  const activating = events.activate(session)
  const live = events.onFrame(session, ask('second'))
  await Promise.all([activating, live])
  expect([...session.pending.keys()]).toEqual(['permission:first', 'permission:second'])
  expect(session.heldFrameBytes).toBe(0)
  session.connection.peer.close()
})
