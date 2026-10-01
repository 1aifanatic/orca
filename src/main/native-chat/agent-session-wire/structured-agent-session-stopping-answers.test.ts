// Which notes answer a person's Stop for "Stopping…": the note keyed by the turn its event records,
// whenever it was first written, and notes written after the event that no other turn owns.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalStatusItem
} from '../../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import { structuredAgentSessionStopping } from './structured-agent-session-stopping'

const FENCE = 1
const journals = createTrackedJournalOpener()
let root: string
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stopping-answers-'))
  journal = await journals.open({
    identity: {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    stateDirectory: join(root, 'session-1')
  })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function turnIdentity(turnId: string): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId, ordinal: 0 }
}

function turn(turnId: string, state: 'running' | 'completed') {
  return journal.appendItem(
    turnIdentity(turnId),
    {
      kind: 'turn',
      turnId,
      state,
      startedAt: 1,
      ...(state === 'running' ? {} : { completedAt: 2 })
    },
    { fence: FENCE, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

const unconfirmed: AgentJournalStatusItem = {
  kind: 'status',
  ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' })
}

function stopping(): boolean {
  return structuredAgentSessionStopping(journal, journal.snapshot().items)
}

describe("a person's Stop's answers", () => {
  it('reads the answer to a later Stop of the same turn from the note an earlier one wrote', async () => {
    await turn('turn-1', 'running')
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1' }, FENCE)
    await journal.appendItem(structuredAgentSessionStopNoteIdentity('turn-1'), unconfirmed, {
      fence: FENCE,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    // A send made since gives the next Stop of this turn an event of its own; its press revised
    // the turn's note in place, so that note keeps its first position.
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1' }, FENCE)

    expect(stopping()).toBe(false)
  })

  it("never reads a Stop of an ended turn as the answer to the running turn's Stop", async () => {
    const ended = await turn('turn-1', 'completed')
    await turn('turn-2', 'running')
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-2' }, FENCE)
    // A phone's late Stop of the ended turn, whose interrupt went unconfirmed.
    await journal.appendItem(structuredAgentSessionStopNoteIdentity('turn-1'), unconfirmed, {
      fence: FENCE,
      turnScope: { kind: 'turn', turnItemId: ended.itemId }
    })

    expect(stopping()).toBe(true)
  })
})
