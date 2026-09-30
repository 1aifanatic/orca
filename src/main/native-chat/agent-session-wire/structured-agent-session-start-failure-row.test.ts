import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { structuredAgentSessionStartFailure } from './structured-agent-session-failure-text'
import {
  recordStructuredAgentSessionStartFailure,
  structuredAgentSessionStartFailureRow,
  structuredAgentSessionStartFailureRowItemId
} from './structured-agent-session-start-failure-row'

const START_KEY = 'generation-1'
let root: string
let journal: AgentSessionJournal
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-start-failure-row-'))
  journal = await journals.open({
    identity: {
      sessionId: 'session-start-failure',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    stateDirectory: root,
    now: () => 1_000
  })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

// A second report of a start whose row is written: the short notice beside that row must not sit
// under a different reason, so the messages take the row's words.
it("rejects a later report's messages in the start's row's words, leaving the row", async () => {
  const first = agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), {
    surface: 'rejection'
  })
  await journal.appendLifecycleBatch({
    settlementId: `start-failure:${START_KEY}`,
    fence: 7,
    recovered: true,
    mutations: [structuredAgentSessionStartFailureRow(START_KEY, first)]
  })
  const row = journal.itemBody(structuredAgentSessionStartFailureRowItemId(START_KEY))
  await journal.appendSubmission({
    clientMessageId: 'client-queued',
    payloadFingerprint: 'fingerprint',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello?' }] },
    fence: 7,
    handoverRecorded: true
  })

  const later = structuredAgentSessionStartFailure({ exit: undefined })
  expect(later.reason).not.toBe(first.reason)
  await recordStructuredAgentSessionStartFailure(
    { journal, fence: 7 },
    { startKey: START_KEY, ...later }
  )

  expect(journal.submissions()).toEqual([
    expect.objectContaining({
      clientMessageId: 'client-queued',
      dispatchState: 'rejected',
      reason: first.reason,
      rejection: { kind: 'notSignedIn' },
      rejectedByStartKey: START_KEY
    })
  ])
  expect(journal.itemBody(structuredAgentSessionStartFailureRowItemId(START_KEY))).toEqual(row)
})
