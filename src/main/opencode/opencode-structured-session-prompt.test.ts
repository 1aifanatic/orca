import { afterEach, expect, it, vi } from 'vitest'
import { OpenCodeStructuredSessionPrompts } from './opencode-structured-session-prompt'
import { OpenCodeStructuredSessionEvents } from './opencode-structured-session-events'
import { openCodeSessionTestFixture } from './opencode-structured-session-test-fixture'
import { ProviderTimelineLane } from '../native-chat/agent-session-timeline/provider-timeline-lane'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

it('preserves v2 child policy and answers once even if saving the chat grant fails', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, request) =>
    request?.method === 'GET'
      ? Response.json({
          data: {
            id: 'child',
            parentID: 'root',
            permissions: [{ action: 'shell', resource: 'restricted', effect: 'deny' }]
          }
        })
      : request?.method === 'PATCH'
        ? new Response(null, { status: 503 })
        : new Response(null, { status: 204 })
  )
  const rig = await openProviderTimelineRig({
    agent: 'opencode2',
    namespace: 'root',
    sessionId: SESSION
  })
  const { session, sessions } = openCodeSessionTestFixture(2, fetchImpl, SESSION)
  session.translator?.registerSession({ id: 'child', parentID: 'root' })
  session.lane = new ProviderTimelineLane({
    sink: rig.eventSink,
    signal: session.streamAbort.signal,
    sessionId: SESSION,
    agent: 'opencode2',
    generation: 'test',
    namespace: 'root'
  })
  const deps = { resolveLaunch: async () => session.launch }
  const events = new OpenCodeStructuredSessionEvents(sessions, deps)
  await events.onFrame(session, {
    type: 'permission.asked',
    data: {
      sessionID: 'child',
      id: 'ask',
      action: 'shell',
      resources: ['echo ok'],
      save: ['echo ok']
    }
  })
  await rig.rows()
  const itemId = session.lane.assembler.requestItemId('permission:ask')
  if (!itemId) {
    throw new Error('fixture approval was not written')
  }
  const close = vi.fn(async () => true)
  const prompts = new OpenCodeStructuredSessionPrompts(sessions, deps, close)
  const commit = vi.fn(async () => {})
  await prompts.answerPrompt({
    sessionId: SESSION,
    itemId,
    fence: 1,
    kind: 'approval',
    response: { kind: 'option', optionId: 'allow-session' },
    commit
  })
  expect(commit).toHaveBeenCalledOnce()
  expect(fetchImpl.mock.calls.find(([, request]) => request?.method === 'PATCH')?.[1]?.body).toBe(
    JSON.stringify({
      permissions: [
        { action: 'shell', resource: 'restricted', effect: 'deny' },
        { action: 'shell', resource: 'echo ok', effect: 'allow' }
      ]
    })
  )
  expect(fetchImpl.mock.calls.at(-1)?.[1]?.body).toBe('{"decision":"once"}')
  expect(close).not.toHaveBeenCalled()
  session.lane.dispose()
  session.connection.peer.close()
})

it.each([1, 2] as const)(
  'cancels the native question without closing the chat in dialect %s',
  async (major) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    const rig = await openProviderTimelineRig({
      agent: major === 1 ? 'opencode' : 'opencode2',
      namespace: 'root',
      sessionId: SESSION
    })
    const { session, sessions } = openCodeSessionTestFixture(major, fetchImpl, SESSION)
    session.lane = new ProviderTimelineLane({
      sink: rig.eventSink,
      signal: session.streamAbort.signal,
      sessionId: SESSION,
      agent: session.launch.agent,
      generation: 'test',
      namespace: 'root'
    })
    const deps = { resolveLaunch: async () => session.launch }
    const events = new OpenCodeStructuredSessionEvents(sessions, deps)
    await events.onFrame(
      session,
      major === 1
        ? {
            type: 'question.asked',
            data: {
              sessionID: 'root',
              id: 'question',
              questions: [{ question: 'Choose?', header: 'Choice', options: [{ label: 'A' }] }]
            }
          }
        : {
            type: 'form.created',
            data: {
              form: {
                sessionID: 'root',
                id: 'question',
                title: 'Questions',
                metadata: { kind: 'question' },
                fields: [
                  {
                    key: 'q0',
                    title: 'Choice',
                    description: 'Choose?',
                    type: 'select',
                    options: [{ value: 'A', label: 'A' }],
                    custom: true
                  }
                ]
              }
            }
          }
    )
    await rig.rows()
    const request = [...session.pending.values()][0]
    const itemId = request && session.lane.assembler.requestItemId(request.request)
    if (!itemId) {
      throw new Error('fixture question was not written')
    }
    const close = vi.fn(async () => true)
    const prompts = new OpenCodeStructuredSessionPrompts(sessions, deps, close)
    await prompts.dismissPrompt({
      sessionId: SESSION,
      itemId,
      fence: 1,
      answer: true,
      commit: async () => {}
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(
        major === 1 ? '/question/question/reject' : '/api/session/root/form/question'
      ),
      expect.objectContaining({ method: major === 1 ? 'POST' : 'DELETE' })
    )
    expect(close).not.toHaveBeenCalled()
    session.lane.dispose()
    session.connection.peer.close()
  }
)
