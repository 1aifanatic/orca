// The queue has no card count limit; only the bytes its cards publish are bounded, because every
// card rides each opening frame a remote client reads. Past that bound a send is refused in words
// that say what to do, and deleting a card makes room again.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentSessionRefusalNotice } from '../../../shared/agent-session-refusal-notice'
import { QUEUED_MESSAGES_PUBLISHED_MAX_BYTES } from './structured-agent-session-queued-messages'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

it('refuses a draft past the published-bytes bound in words that say what to do', async () => {
  await rig.workingSend()
  const text = 'x'.repeat(Math.ceil(QUEUED_MESSAGES_PUBLISHED_MAX_BYTES * 0.6))
  const first = await rig.send(text, 'queue-if-active').result
  if (!first.ok || !('queued' in first.value)) {
    throw new Error('expected the first draft queued')
  }
  const refused = await rig.send(text, 'queue-if-active').result
  if (refused.ok) {
    throw new Error('expected a refusal')
  }
  expect(refused.refusal.details).toEqual({ reason: 'queueTooLarge' })
  expect(agentSessionRefusalNotice(refused.refusal, 'composer-send')).toBe(
    'Too much text is waiting in the queue. Your message was not sent. Send or delete a queued message, then try again.'
  )
  expect(await rig.deleteQueued(first.value.queued.messageId)).toMatchObject({ ok: true })
  expect(await rig.send(text, 'queue-if-active').result).toMatchObject({
    ok: true,
    value: { queued: { state: 'waiting' } }
  })
})
