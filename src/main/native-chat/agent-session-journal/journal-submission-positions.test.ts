// Each submission carries where the journal wrote its row and the row that resolved it, so a client
// can place a send by journal order instead of guessing from clocks. Derived on every fold: a
// replay of the same rows gives the same values, and a history page carries them.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { readAgentSessionHydrationPage } from '../agent-session-wire/agent-session-history-page'
import { createTrackedJournalOpener } from './journal-host-database-test-support'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}
const BODY: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'look around' }]
}

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

/** A send accepted for later handover, handed over, then taken back. */
async function sendHandedOverThenWithdrawn() {
  root = await mkdtemp(join(tmpdir(), 'orca-submission-positions-'))
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  const submitted = await journal.appendSubmission({
    clientMessageId: 'send-1',
    payloadFingerprint: 'send-1',
    body: BODY,
    fence: 1,
    handoverRecorded: true
  })
  const handedOver = await journal.resolveDispatch({
    clientMessageId: 'send-1',
    state: 'pending',
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  const pending = { ...journal.submission('send-1') }
  const withdrawn = await journal.resolveDispatch({
    clientMessageId: 'send-1',
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' }),
    fence: 1,
    recovered: true
  })
  return { journal, submitted, handedOver, pending, withdrawn }
}

describe("a submission's journal positions", () => {
  it('are its own row and the row that resolved it, with none while it is pending', async () => {
    const { journal, submitted, handedOver, pending, withdrawn } =
      await sendHandedOverThenWithdrawn()

    expect(pending).toMatchObject({ submittedSequence: submitted.sequence })
    expect(pending).not.toHaveProperty('resolvedSequence')
    expect(handedOver.sequence).toBeGreaterThan(submitted.sequence)
    expect(journal.submission('send-1')).toMatchObject({
      dispatchState: 'rejected',
      submittedSequence: submitted.sequence,
      resolvedSequence: withdrawn.sequence
    })
  })

  it('come back the same from a replay of the stored rows', async () => {
    const { journal, submitted, withdrawn } = await sendHandedOverThenWithdrawn()
    await journals.closeAll()

    const replayed = await journals.open({ identity: IDENTITY, stateDirectory: root! })

    expect(replayed.submission('send-1')).toMatchObject({
      submittedSequence: submitted.sequence,
      resolvedSequence: withdrawn.sequence
    })
    expect(journal).not.toBe(replayed)
  })

  it("move to the provider's echo when that is what accepts a send left in doubt", async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-submission-positions-'))
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const submitted = await journal.appendSubmission({
      clientMessageId: 'send-1',
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: IDENTITY.sessionId,
        fields: { body: BODY }
      }),
      body: BODY,
      fence: 1
    })
    const doubted = await journal.resolveDispatch({
      clientMessageId: 'send-1',
      state: 'unknown',
      reason: 'host_restarted',
      fence: 1,
      recovered: true
    })

    const echo = await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      BODY,
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    expect(echo.cursor.sequence).toBeGreaterThan(doubted.sequence)
    expect(journal.submission('send-1')).toMatchObject({
      dispatchState: 'accepted',
      submittedSequence: submitted.sequence,
      resolvedSequence: echo.cursor.sequence
    })
  })

  it('reach a client on the history page', async () => {
    const { journal, submitted, withdrawn } = await sendHandedOverThenWithdrawn()

    expect(readAgentSessionHydrationPage(journal).submissions).toEqual([
      expect.objectContaining({
        clientMessageId: 'send-1',
        submittedSequence: submitted.sequence,
        resolvedSequence: withdrawn.sequence
      })
    ])
  })
})
