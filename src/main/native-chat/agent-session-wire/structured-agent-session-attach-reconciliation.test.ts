// Attach is where the restart reconciler runs. These cover the wiring itself:
// that the window the adapter reports reaches the journal, that what it settles
// stops being reported unconfirmed, and that deciding never sends.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { digestPayload } from '../agent-session-journal/journal-payload-bounds'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import type { ProviderHistorySource } from '../agent-session-journal/journal-submission-reconciler'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { openTestAttachConversation } from './structured-agent-session-attach-test-conversation'
import {
  attachJournal,
  journalIdentityFor,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'

const RECORD = agentSessionRecordFixture()

const PARAMS = {
  envelope: {
    sessionId: RECORD.sessionId,
    clientOperationId: 'op-1',
    expectedRuntimeFence: RECORD.lease.runtimeFence,
    payloadFingerprint: 'fp'
  },
  location: RECORD.location,
  provider: 'claude',
  agent: 'claude',
  accountHome: RECORD.accountHome,
  runtimeKind: 'native'
} as unknown as AgentSessionAttachParams

const IDENTITY = journalIdentityFor(RECORD, PARAMS)

let root: string
const journals = createTrackedJournalOpener()

function userMessage(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

const SENT_FRAME = { provider: 'claude', sessionId: 'provider-1', uuid: 'cm_1-frame' } as const

/** A transcript that holds `cm_1`'s frame and nothing else. */
function window(overrides: Partial<ProviderHistorySource> = {}): ProviderHistorySource {
  return {
    turnInFlight: false,
    readWindow: async () => ({ items: [], boundaryConsistent: true }),
    readRecorded: async () => ({ itemIds: new Set([agentJournalItemKey(SENT_FRAME)]) }),
    ...overrides
  }
}

/** Only the surface `attachJournal` touches; every send-shaped method is a spy
 *  so a re-delivery would be visible rather than silent. */
function adapterWith(providerHistory?: () => Promise<ProviderHistorySource | null>): {
  adapter: StructuredAgentSessionAdapter
  dispatch: ReturnType<typeof vi.fn>
} {
  const dispatch = vi.fn()
  const surface = { dispatch, ...(providerHistory ? { providerHistory } : {}) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attachJournal reads only these members.
  const adapter = surface as unknown as StructuredAgentSessionAdapter
  return { adapter, dispatch }
}

/** A previous process wrote the submission row and died before its outcome. */
async function crashedJournal(clientMessageId = 'cm_1', text = 'deploy the thing') {
  const journal = await journals.open({
    identity: IDENTITY,
    journalDir: journalDirectoryFor(root, {
      workspaceId: IDENTITY.workspaceId,
      sessionId: IDENTITY.sessionId
    })
  })
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: digestPayload(text),
    body: userMessage(text),
    fence: RECORD.lease.runtimeFence
  })
  await journal.resolveDispatch({
    clientMessageId,
    state: 'pending',
    providerIdentity: {
      provider: 'claude',
      sessionId: 'provider-1',
      uuid: `${clientMessageId}-frame`
    },
    fence: RECORD.lease.runtimeFence
  })
  await journal.close()
}

async function attach(adapter: StructuredAgentSessionAdapter) {
  const attached = await attachJournal({
    record: RECORD,
    params: PARAMS,
    journalRoot: root,
    openConversation: openTestAttachConversation(root),
    adapter
  })
  journals.track(attached.journal)
  return attached
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-attach-reconcile-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('attachJournal restart reconciliation', () => {
  it('settles a send found by its frame id and stops reporting it unconfirmed', async () => {
    await crashedJournal()
    const { adapter, dispatch } = adapterWith(async () => window())

    const attached = await attach(adapter)

    expect(attached.unconfirmedClientMessageIds).toEqual([])
    expect(attached.journal.submissions()[0]).toMatchObject({
      dispatchState: 'accepted',
      providerItemId: agentJournalItemKey(SENT_FRAME)
    })
    // Deciding is not sending: nothing here puts the message back on the wire.
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('still reports a submission unconfirmed when history does not hold it', async () => {
    await crashedJournal('cm_2')
    const { adapter, dispatch } = adapterWith(async () => window())

    const attached = await attach(adapter)

    expect(attached.unconfirmedClientMessageIds).toEqual(['cm_2'])
    expect(attached.journal.submissions()[0]?.dispatchState).toBe('unknown')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('leaves the crash boundary untouched for an adapter that reports no history', async () => {
    await crashedJournal()
    const { adapter } = adapterWith()

    const attached = await attach(adapter)

    expect(attached.unconfirmedClientMessageIds).toEqual(['cm_1'])
    expect(attached.journal.submissions()[0]?.dispatchState).toBe('unknown')
  })

  it('does not fail the attach when reading provider history throws', async () => {
    await crashedJournal()
    const { adapter } = adapterWith(async () => {
      throw new Error('transcript unreadable')
    })

    const attached = await attach(adapter)

    expect(attached.unconfirmedClientMessageIds).toEqual(['cm_1'])
    expect(attached.journal.submissions()[0]?.dispatchState).toBe('unknown')
  })

  it('leaves a message the open conversation still has queued alone (W4′e)', async () => {
    const journal = await journals.open({
      identity: IDENTITY,
      journalDir: journalDirectoryFor(root, {
        workspaceId: IDENTITY.workspaceId,
        sessionId: IDENTITY.sessionId
      })
    })
    await journal.appendSubmission({
      clientMessageId: 'queued',
      payloadFingerprint: digestPayload('still queued'),
      body: userMessage('still queued'),
      fence: RECORD.lease.runtimeFence,
      handoverRecorded: true
    })
    const { adapter, dispatch } = adapterWith(async () => window())

    const attached = await attachJournal({
      record: RECORD,
      params: PARAMS,
      journalRoot: root,

      adapter,
      openConversation: async () => journal
    })

    expect(attached.journal).toBe(journal)
    expect(journal.submissions()[0]).toMatchObject({ dispatchState: 'pending' })
    expect(journal.submissions()[0]?.handedOverAt).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()
  })
})
