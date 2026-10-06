import { afterEach, expect, it, vi } from 'vitest'
import { OpenCodeStructuredSessionEvents } from './opencode-structured-session-events'
import { dispatchOpenCodeSession } from './opencode-structured-session-dispatch'
import { openCodeSessionTestFixture } from './opencode-structured-session-test-fixture'
import { openCodeUserIdentity } from './opencode-structured-session-identity'
import { ProviderTimelineLane } from '../native-chat/agent-session-timeline/provider-timeline-lane'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

it.each([1, 2] as const)(
  'keeps a newer command receipt when the earlier turn ends in dialect %s',
  async (major) => {
    let release = (_response: Response): void => {}
    let nativeId = 'msg_newer'
    const fetchImpl = vi.fn<typeof fetch>(async (_url, request) => {
      if (major === 1 && typeof request?.body === 'string') {
        nativeId = JSON.parse(request.body).messageID
      }
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    })
    const { session, sessions } = openCodeSessionTestFixture(major, fetchImpl, SESSION)
    const rig = await openProviderTimelineRig({
      agent: session.launch.agent,
      namespace: 'root',
      sessionId: SESSION
    })
    session.lane = new ProviderTimelineLane({
      sink: rig.eventSink,
      signal: session.streamAbort.signal,
      sessionId: SESSION,
      agent: session.launch.agent,
      generation: 'race',
      namespace: 'root'
    })
    await rig.journal.appendSubmission({
      clientMessageId: 'newer',
      payloadFingerprint: 'command-fixture',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '/review src' }] },
      fence: 1
    })
    session.commands = [{ name: 'review', kind: 'command' }]
    session.translator?.open('root', 'older', 100)
    const settled = vi.fn()
    const events = new OpenCodeStructuredSessionEvents(sessions, {
      resolveLaunch: async () => session.launch,
      onDispatchSettledLate: settled
    })
    const sending = dispatchOpenCodeSession(session, {
      sessionId: SESSION,
      clientMessageId: 'newer',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '/review src' }] },
      fence: 1
    })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    await events.onFrame(
      session,
      major === 1
        ? { type: 'session.idle', data: { sessionID: 'root' } }
        : { type: 'session.execution.succeeded', data: { sessionID: 'root' } }
    )
    expect(session.dispatchOrder[0]?.clientMessageId).toBe('newer')
    expect(session.outstanding.has('newer')).toBe(true)
    await events.onFrame(
      session,
      major === 1
        ? {
            type: 'message.updated',
            data: { info: { sessionID: 'root', id: nativeId, role: 'user' } }
          }
        : {
            type: 'session.inbox.enqueued',
            data: {
              sessionID: 'root',
              inboxID: nativeId,
              item: { type: 'user', payload: { text: '/review src' } }
            }
          }
    )
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      sessionId: SESSION,
      clientMessageId: 'newer',
      providerIdentity: openCodeUserIdentity({
        agent: session.launch.agent,
        sessionId: SESSION,
        nativeSessionId: 'root',
        nativeMessageId: nativeId
      })
    })
    release(major === 1 ? Response.json({}) : new Response(null, { status: 204 }))
    expect(await sending).toEqual({ state: 'admitted' })
    expect(session.outstanding.size).toBe(0)
    expect(session.translator?.turns.get('root')).toBe(nativeId)
    session.lane.dispose()
    session.connection.peer.close()
  }
)

it.each([1, 2] as const)(
  'replays one accepted user row with its original image in dialect %s',
  async (major) => {
    const agent = major === 1 ? 'opencode' : 'opencode2'
    const rig = await openProviderTimelineRig({ agent, namespace: 'root', sessionId: SESSION })
    const body = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'Describe this' },
        { type: 'image-ref', path: '/workspace/image.png', alt: 'image.png' }
      ]
    } as const
    await rig.journal.appendSubmission({
      clientMessageId: 'photo',
      payloadFingerprint: 'image-fixture',
      body: { ...body, blocks: [...body.blocks] },
      fence: 1
    })
    await rig.journal.resolveDispatch({
      clientMessageId: 'photo',
      state: 'accepted',
      providerIdentity: openCodeUserIdentity({
        agent,
        sessionId: SESSION,
        nativeSessionId: 'root',
        nativeMessageId: 'msg_photo'
      }),
      fence: 1
    })
    const { session } = openCodeSessionTestFixture(major, async () => Response.json({}), SESSION)
    const lane = new ProviderTimelineLane({
      sink: rig.eventSink,
      signal: session.streamAbort.signal,
      sessionId: SESSION,
      agent,
      generation: 'resumed',
      namespace: 'root'
    })
    await lane.apply(
      session.translator!.history(
        major === 1
          ? [
              {
                info: { id: 'msg_photo', sessionID: 'root', role: 'user' },
                parts: [
                  { type: 'text', text: 'Describe this' },
                  { type: 'text', synthetic: true, text: 'Called the Read tool' },
                  { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }
                ]
              }
            ]
          : [
              {
                id: 'msg_photo',
                type: 'user',
                text: 'Describe this',
                files: [{ mime: 'image/png', data: 'aGVsbG8=' }]
              }
            ]
      )
    )
    const users = (await rig.rows()).filter(
      (row) => row.body.kind === 'message' && row.body.role === 'user'
    )
    expect(users).toHaveLength(1)
    expect(users[0]?.body).toEqual(body)
    lane.dispose()
    session.connection.peer.close()
  }
)
