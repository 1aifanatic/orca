// The Claude history an attach samples, read end to end: transcript file, liveness, journal verdict.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { digestPayload } from '../native-chat/agent-session-journal/journal-payload-bounds'
import { reconcileJournalSubmissionsAgainstHistory } from '../native-chat/agent-session-journal/journal-restart-reconciliation'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-store-test-open'
import { openClaudeProviderHistory } from './claude-structured-provider-history'

const PROVIDER_SESSION = 'provider-1'

// No turn has completed yet, so there is no durable anchor.
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION, leafUuid: null }
}

const journals = createTrackedJournalOpener()
let root: string

function userMessage(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

/** A transcript holding only a turn Claude is still running, and a send handed over during it. */
async function strandedMidTurn() {
  const projectDir = join(root, 'account', 'projects', 'work')
  await mkdir(projectDir, { recursive: true })
  const running = {
    type: 'user',
    uuid: 'running-turn',
    parentUuid: null,
    sessionId: PROVIDER_SESSION,
    message: { role: 'user', content: 'run the tests' }
  }
  await writeFile(join(projectDir, `${PROVIDER_SESSION}.jsonl`), `${JSON.stringify(running)}\n`)
  const journalDir = join(root, 'journal')
  const journal = await journals.open({ identity: IDENTITY, journalDir })
  await journal.appendSubmission({
    clientMessageId: 'cm-sent',
    payloadFingerprint: digestPayload('ship it'),
    body: userMessage('ship it'),
    fence: 1
  })
  await journal.resolveDispatch({
    clientMessageId: 'cm-sent',
    state: 'pending',
    providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION, uuid: 'sent' },
    fence: 1
  })
  const reopened = await journals.open({ identity: IDENTITY, journalDir })
  await reopened.markPendingSubmissionsUnknown(2)
  return reopened
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-provider-history-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('openClaudeProviderHistory', () => {
  it('leaves a send unknown while a turn runs, even with no anchor to read a window from', async () => {
    const journal = await strandedMidTurn()
    const history = openClaudeProviderHistory({
      identity: IDENTITY,
      accountHomePath: join(root, 'account'),
      hasLiveSession: true
    })

    await reconcileJournalSubmissionsAgainstHistory({ journal, fence: 2, history: history! })

    // Claude may not have written the record yet, so its absence proves nothing.
    expect(journal.submissions()[0]?.dispatchState).toBe('unknown')
  })

  it('decides the same send not delivered once no child can still be writing', async () => {
    const journal = await strandedMidTurn()
    const history = openClaudeProviderHistory({
      identity: IDENTITY,
      accountHomePath: join(root, 'account'),
      hasLiveSession: false
    })

    await reconcileJournalSubmissionsAgainstHistory({ journal, fence: 2, history: history! })

    expect(journal.submissions()[0]?.dispatchState).toBe('rejected')
  })
})
