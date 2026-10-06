import { afterEach, expect, it, vi } from 'vitest'
import { restoreOpenCodeSessionHistory } from './opencode-structured-session-history'
import { openCodeSessionTestFixture } from './opencode-structured-session-test-fixture'
import { OpenCodeHttpError } from './serve/http-response'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

it('reports bounded native history through the existing actionable restore refusal', async () => {
  const { session } = openCodeSessionTestFixture(2, async () => Response.json({}), SESSION)
  session.launch.resumeSessionId = 'root'
  const rig = await openProviderTimelineRig({
    agent: 'opencode2',
    namespace: 'root',
    sessionId: SESSION
  })
  if (!session.client) {
    throw new Error('fixture client is absent')
  }
  vi.spyOn(session.client, 'history').mockRejectedValue(
    new OpenCodeHttpError('capacity', 'history exceeds restore limit')
  )
  await expect(restoreOpenCodeSessionHistory(session, rig.eventSink)).rejects.toMatchObject({
    reason: 'historyTooLarge'
  })
  session.lane?.dispose()
  session.connection.peer.close()
})
