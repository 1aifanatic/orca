// The host publishes which pause holds each card, and a client reading its updates one at a time
// sees the queue's run continue across a turn's end and the queue's send of the next card: no
// card flips Steer → Send → Steer, and Resume is never offered in between.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../shared/agent-session-wire'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import {
  projectQueuedMessageCards,
  queuedMessageCardSteers,
  queuedMessageQueueRun
} from '../../../renderer/src/components/native-chat/structured-agent-session-queued-cards'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(() => rig.dispose())

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

/** Each waiting card's published hold, by id. */
async function heldBy(): Promise<Record<string, AgentSessionQueuePause | null | undefined>> {
  const page = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  return Object.fromEntries(
    (page.page.queuedMessages ?? []).map((card) => [card.messageId, card.heldBy])
  )
}

type ClientView = { resumable: boolean; steers: boolean[]; cards: number; working: boolean }

/** Folds every published update as a client does, one at a time, into what its queue shows. */
async function watchClient(): Promise<ClientView[]> {
  const views: ClientView[] = []
  const submissions = new Map<string, AgentJournalSubmission>()
  const turns = new Map<string, string>()
  let queued: AgentSessionQueuedMessage[] = []
  let queuePause: AgentSessionQueuePause | null = null
  await rig.host.subscribe({
    id: 'client-view',
    sessionId: HOST_TEST_SESSION,
    emit: (event) => {
      if (event.type === 'end') {
        return
      }
      const rows = event.type === 'batch' ? event.batch : event.page
      for (const submission of rows.submissions) {
        submissions.set(submission.clientMessageId, submission)
      }
      for (const item of rows.items) {
        if (item.body.kind === 'turn') {
          turns.set(item.itemId, item.body.state)
        }
      }
      if (event.queuedMessages !== undefined) {
        queued = event.queuedMessages ?? []
        queuePause = event.queuePause ?? null
      }
      const running = [...turns].find(([, state]) => state === 'running')?.[0] ?? null
      const all = [...submissions.values()]
      const cards = projectQueuedMessageCards(queued, all, {
        hasPendingPrompt: false,
        queuePaused: queuePause !== null
      })
      const working = isStructuredAgentSessionMainAgentWorking(running, all)
      const run = queuedMessageQueueRun(cards, working)
      views.push({
        resumable: run.resumable,
        steers: cards.map((card) => queuedMessageCardSteers(card, run.turnRunning)),
        cards: cards.length,
        working
      })
    }
  })
  return views
}

describe('which pause holds each card', () => {
  it("a Stop's: the card queued before it, not the one typed while it lands; Resume and Send never show as the queue sends them", async () => {
    const working = await rig.workingSend()
    const held = await queuedDraft('held by the stop')
    await rig.stop()
    const typed = await queuedDraft('typed while the stop lands')
    expect(await heldBy()).toEqual({ [held]: { reason: 'stopped' }, [typed]: null })
    const views = await watchClient()
    await rig.settleAccepted(working, 'stopped')
    await eventually(async () => expect(await rig.handoff(typed)).toBeDefined())
    await rig.settleAccepted(await rig.handoffId(typed), 'typed')
    await eventually(async () => expect(await rig.handoff(held)).toBeDefined())
    // The update between the stopped turn's end and the typed card's send is among them.
    expect(views).toContainEqual({
      resumable: false,
      steers: [true, true],
      cards: 2,
      working: false
    })
    expect(views.filter((view) => view.resumable)).toEqual([])
    expect(views.flatMap((view) => view.steers)).not.toContain(false)
  })

  it("a restart's: the card from before it, not one typed during Orca's own turn since; the same holds as that turn ends", async () => {
    const working = await rig.workingSend()
    const before = await queuedDraft('written before the restart')
    await rig.restartHostProcess()
    await rig.settleAccepted(working, 'a')
    const continuation = rig.send('continue where you left off', undefined, { internal: true })
    await continuation.result
    await eventually(async () =>
      expect((await rig.submission(continuation.id))?.handedOverAt).toBeDefined()
    )
    const typed = await queuedDraft('typed during the continuation')
    expect(await heldBy()).toEqual({ [before]: { reason: 'restarted' }, [typed]: null })
    const views = await watchClient()
    await rig.settleAccepted(continuation.id, 'continuation')
    await eventually(async () => expect(await rig.handoff(typed)).toBeDefined())
    expect(views).toContainEqual({
      resumable: false,
      steers: [true, true],
      cards: 2,
      working: false
    })
    expect(views.filter((view) => view.resumable)).toEqual([])
    expect(views.flatMap((view) => view.steers)).not.toContain(false)
  })
})
