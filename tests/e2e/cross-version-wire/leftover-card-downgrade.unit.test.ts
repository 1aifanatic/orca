import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../src/shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import { createTrackedJournalOpener } from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { holdJournalLeftoverSends } from '../../../src/main/native-chat/agent-session-journal/journal-leftover-send-hold'
import { QUEUED_MESSAGE_HELD_ACROSS_RESTART } from '../../../src/main/native-chat/agent-session-journal/queued-message-pause'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// A send a restart kept is an ordinary waiting card: a value in the host-instance column and a
// place ahead of the queue, no new state or column. A build from before it must still list it,
// first, under its restart pause, and must still settle a leftover this build's quit left queued.
// The main commit this change branched from; move it to the first release that holds this change.
const BASELINE_REF = '5a56636f6679071d6ec68b851ef7932cd3222560'
const JOURNAL = 'src/main/native-chat/agent-session-journal'
const HOST_RESTARTED = agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), {
  surface: 'rejection'
})

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-kept-downgrade',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'native-1', leafUuid: null }
}

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

type OlderCard = { messageId: string; state: string; position: number; hostInstance: string }

type OlderJournal = {
  queuedMessages: {
    list: () => readonly OlderCard[]
    pauses: (hostInstance: string) => { reason: string }[]
  }
  submission: (id: string) => { dispatchState: string; reason: string | null } | undefined
  wroteBeforeOpen: (sequence: number | undefined) => boolean
  rejectQueuedSubmissions: (
    fence: number,
    rejection: typeof HOST_RESTARTED,
    which: (submission: { acceptedSequence?: number }) => boolean
  ) => Promise<string[]>
  repair: { malformedRows: number }
}

type OlderOpener = {
  open: (options: {
    identity: AgentSessionJournalIdentity
    stateDirectory: string
  }) => Promise<OlderJournal>
  closeAll: () => Promise<void>
}

async function olderOpener(): Promise<OlderOpener> {
  const checkout = await materializeReleaseCheckout(BASELINE_REF)
  const support = await importReleaseCheckoutModule(
    checkout,
    `${JOURNAL}/journal-host-database-test-support.ts`
  )
  const create = support.createTrackedJournalOpener
  if (typeof create !== 'function') {
    throw new Error('the pinned build exports no createTrackedJournalOpener')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned build's own test opener; each member read here is named in `OlderOpener`, and a changed one fails the test.
  return create() as OlderOpener
}

async function acceptPersonSend(
  journal: Awaited<ReturnType<ReturnType<typeof createTrackedJournalOpener>['open']>>,
  id: string
): Promise<void> {
  await journal.appendSubmission({
    clientMessageId: id,
    payloadFingerprint: `fp-${id}`,
    body: message(id),
    fence: 0,
    handoverRecorded: true,
    origin: 'client',
    source: 'person'
  })
}

test('an older build lists a kept card first, held by its restart pause', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-kept-card-downgrade-'))
  const journals = createTrackedJournalOpener()
  try {
    const earlier = await journals.open({ identity: IDENTITY, stateDirectory: directory })
    await earlier.queuedMessages.insert({
      messageId: 'queued-card',
      body: message('queued-card'),
      fingerprint: 'fp-queued-card',
      hostInstance: 'host-a'
    })
    await acceptPersonSend(earlier, 'kept')
    await journals.closeAll()
    const reopened = await journals.open({ identity: IDENTITY, stateDirectory: directory })
    await holdJournalLeftoverSends(reopened, 0)
    expect(reopened.queuedMessages.list().map((card) => card.messageId)).toEqual([
      'kept',
      'queued-card'
    ])
    await journals.closeAll()

    const older = await olderOpener()
    try {
      const downgraded = await older.open({ identity: IDENTITY, stateDirectory: directory })
      expect(
        downgraded.queuedMessages.list().map(({ messageId, state, hostInstance }) => ({
          messageId,
          state,
          hostInstance
        }))
      ).toEqual([
        { messageId: 'kept', state: 'waiting', hostInstance: QUEUED_MESSAGE_HELD_ACROSS_RESTART },
        { messageId: 'queued-card', state: 'waiting', hostInstance: 'host-a' }
      ])
      expect(downgraded.queuedMessages.list()[0]!.position).toBeLessThan(1)
      expect(downgraded.queuedMessages.pauses('host-b').map((pause) => pause.reason)).toEqual([
        'restarted'
      ])
      expect(downgraded.submission('kept')).toMatchObject({ dispatchState: 'rejected' })
    } finally {
      await older.closeAll()
    }
  } finally {
    await journals.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
}, 120_000)

test("an older build reads the send this build's quit left queued, its source included, and settles it", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-kept-leftover-downgrade-'))
  const journals = createTrackedJournalOpener()
  try {
    const quitting = await journals.open({ identity: IDENTITY, stateDirectory: directory })
    await acceptPersonSend(quitting, 'left-queued')
    await journals.closeAll()

    const older = await olderOpener()
    try {
      const downgraded = await older.open({ identity: IDENTITY, stateDirectory: directory })
      expect(downgraded.repair).toEqual({ malformedRows: 0 })
      expect(downgraded.submission('left-queued')).toMatchObject({ dispatchState: 'pending' })
      // Its delivery loop's first step, as that build runs it: rejected, never handed over.
      expect(
        await downgraded.rejectQueuedSubmissions(0, HOST_RESTARTED, (submission) =>
          downgraded.wroteBeforeOpen(submission.acceptedSequence)
        )
      ).toEqual(['left-queued'])
      expect(downgraded.submission('left-queued')).toMatchObject({
        dispatchState: 'rejected',
        reason: HOST_RESTARTED.reason
      })
    } finally {
      await older.closeAll()
    }
  } finally {
    await journals.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
}, 120_000)
