import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import type { AgentSessionJournalIdentity } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../src/shared/agent-session-wire'
import { createTrackedJournalOpener } from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { readAgentSessionHydrationPage } from '../../../src/main/native-chat/agent-session-wire/agent-session-history-page'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// A released client that predates the published submission position and answered turn: it must fold
// and draw a page carrying them exactly as it draws the same page without them.
const BASELINE_REF = 'v1.4.219'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-positions',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

/** A function the pinned release exports, typed as the caller calls it. */
function releaseExport<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) {
    throw new Error(`the pinned release exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a value the pinned release exports; each caller names the shape it uses, and a changed one fails the test.
  return value as T
}

type OldState = { submissions: Record<string, unknown>[]; items: unknown[] }

/** Strips the published position and answered turn, as an older host's page would carry its
 *  submissions. */
function withoutPosition(page: AgentSessionHistoryPage): AgentSessionHistoryPage {
  return {
    ...page,
    submissions: page.submissions.map(
      ({ submittedSequence: _submitted, answeredInTurnItemId: _turn, ...rest }) => rest
    )
  }
}

// Loads a real release checkout, cold extraction and transforms included.
test('a released client folds and draws a page whose submissions carry their journal position and answered turn', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-submission-positions-downgrade-'))
  const journals = createTrackedJournalOpener()
  try {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: directory })
    for (const id of ['taken-back', 'still-queued']) {
      await journal.appendSubmission({
        clientMessageId: id,
        payloadFingerprint: id,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
        fence: 1,
        handoverRecorded: true
      })
    }
    await journal.resolveDispatch({
      clientMessageId: 'taken-back',
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' }),
      fence: 1,
      recovered: true
    })
    await journal.appendSubmission({
      clientMessageId: 'turn-ended',
      payloadFingerprint: 'turn-ended',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'turn-ended' }] },
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'turn-ended',
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' }),
      answeredInTurn: {
        provider: 'legacy',
        agent: 'codex',
        sessionId: IDENTITY.sessionId,
        recordId: 'turn-lifecycle:turn-1'
      },
      fence: 1
    })
    const page = readAgentSessionHydrationPage(journal, 1)
    // Anti-vacuous: the page this build publishes does carry both.
    expect(page.submissions.find((entry) => entry.clientMessageId === 'taken-back')).toEqual(
      expect.objectContaining({
        submittedSequence: expect.any(Number)
      })
    )
    expect(page.submissions.find((entry) => entry.clientMessageId === 'turn-ended')).toEqual(
      expect.objectContaining({ answeredInTurnItemId: expect.any(String) })
    )

    const checkout = await materializeReleaseCheckout(BASELINE_REF)
    const reducer = await importReleaseCheckoutModule(
      checkout,
      'src/shared/structured-agent-session-reducer.ts'
    )
    const projection = await importReleaseCheckoutModule(
      checkout,
      'src/shared/structured-agent-session-message-projection.ts'
    )
    const reduce = releaseExport<(state: unknown, action: unknown) => OldState>(
      reducer,
      'reduceStructuredAgentSession'
    )
    const empty = releaseExport<unknown>(reducer, 'EMPTY_STRUCTURED_AGENT_SESSION')
    const project = releaseExport<
      (items: unknown[], outbox: unknown[], submissions: unknown[]) => unknown[]
    >(projection, 'projectStructuredAgentSessionMessages')
    const draw = (from: AgentSessionHistoryPage) => {
      const state = reduce(empty, { type: 'history-page', page: from })
      return {
        submissions: state.submissions.map(
          ({ submittedSequence: _s, answeredInTurnItemId: _t, ...rest }) => rest
        ),
        messages: project(state.items, [], state.submissions)
      }
    }

    expect(draw(page)).toEqual(draw(withoutPosition(page)))
  } finally {
    await journals.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
}, 180_000)
