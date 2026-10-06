import { expect, test } from 'vitest'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../src/shared/agent-session-wire'
import { projectQueuedMessageCards } from '../../../src/renderer/src/components/native-chat/structured-agent-session-queued-cards'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// Each published card now names the kind of its sender (`source`), so a client labels another
// agent's mail, which a person's Stop does not hold, as waiting rather than paused. The field is
// optional: a build without it ignores it and labels every card under a pause as before, and this
// build reads a card from a host without it as the person's. The main commit this change branched
// from, which has the queue; move it to the newest release that has the queue and predates this
// change. A baseline holding this change tests no downgrade.
const BASELINE_REF = '5a56636f6679071d6ec68b851ef7932cd3222560'
const CARDS = 'src/renderer/src/components/native-chat/structured-agent-session-queued-cards.ts'
const STOPPED: AgentSessionQueuePause = { reason: 'stopped' }

function card(messageId: string, position: number, kind?: string): AgentSessionQueuedMessage {
  return {
    messageId,
    position,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: messageId }] },
    state: 'waiting',
    ...(kind === undefined ? {} : { source: { kind } })
  }
}

type OlderProjection = (
  queuedMessages: readonly unknown[],
  submissions: readonly unknown[],
  session: { hasPendingPrompt: boolean; queuePaused?: boolean }
) => readonly { messageId: string; hold: string }[]

async function olderProjection(): Promise<OlderProjection> {
  const checkout = await materializeReleaseCheckout(BASELINE_REF)
  const cards = await importReleaseCheckoutModule(checkout, CARDS)
  const project = cards.projectQueuedMessageCards
  if (typeof project !== 'function') {
    throw new Error('the pinned build exports no projectQueuedMessageCards')
  }
  return (queuedMessages, submissions, session) => project(queuedMessages, submissions, session)
}

test("an older client reads this host's cards, mail included, as paused under a person's Stop, as before", async () => {
  const project = await olderProjection()
  const held = project([card('typed', 1, 'user'), card('mail', 2, 'agent')], [], {
    hasPendingPrompt: false,
    queuePaused: true
  })
  expect(held.map((entry) => [entry.messageId, entry.hold])).toEqual([
    ['typed', 'queue-paused'],
    ['mail', 'queue-paused']
  ])
})

test("this client reads an older host's cards, which name no sender, as the person's", () => {
  const held = projectQueuedMessageCards([card('typed', 1), card('mail-unnamed', 2)], [], {
    hasPendingPrompt: false,
    queuePause: STOPPED
  })
  expect(held.map((entry) => entry.hold)).toEqual(['queue-paused', 'queue-paused'])
})
