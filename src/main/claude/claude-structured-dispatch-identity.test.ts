// The id a restart decides delivery by: chosen before the hand-over, durable with it, and the
// exact id the frame Claude records carries.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-store-test-open'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { handOverSubmission } from '../native-chat/agent-session-wire/structured-agent-session-turns'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import {
  claudeRecordedFrameUuid,
  mintClaudeDispatchIdentity
} from './claude-structured-dispatch-content'
import { sessionFor, userMessage } from './claude-structured-dispatch-test-support'
import {
  acquired,
  fakeClaude,
  PROVIDER_SESSION_ID,
  USER_MESSAGE
} from './claude-structured-session-test-support'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'provider-session', leafUuid: null }
}

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-dispatch-identity-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('the Claude dispatch identity', () => {
  it('names a plain prompt by a fresh uuid in the live session', () => {
    const identity = mintClaudeDispatchIdentity(
      'provider-session',
      userMessage([{ type: 'text', text: 'ship it' }])
    )
    expect(identity).toMatchObject({ provider: 'claude', sessionId: 'provider-session' })
  })

  it('leaves a slash command to content, since Claude records no prompt for it', () => {
    expect(
      mintClaudeDispatchIdentity(
        'provider-session',
        userMessage([{ type: 'text', text: '/compact' }])
      )
    ).toBeNull()
  })

  it('stamps the recorded uuid on the frame, and only for the session it names', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const session = sessionFor(send)
    const recorded = { provider: 'claude', sessionId: 'provider-session', uuid: 'frame-1' } as const
    const sentUuid = claudeRecordedFrameUuid(session.providerSessionId, recorded)

    await dispatchClaudeTurn(session, {
      body: userMessage([{ type: 'text', text: 'ship it' }]),
      sentUuid
    })

    expect(send.mock.calls[0]?.[0]).toMatchObject({ uuid: 'frame-1' })
    expect(claudeRecordedFrameUuid('another-session', recorded)).toBeUndefined()
  })
})

describe('handing a send over under its identity', () => {
  it('records the id before dispatch and keeps it through a crash', async () => {
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    await journal.appendSubmission({
      clientMessageId: 'cm-1',
      payloadFingerprint: 'fingerprint',
      body: userMessage([{ type: 'text', text: 'ship it' }]),
      fence: 1,
      handoverRecorded: true
    })
    const identity = { provider: 'claude', sessionId: 'provider-session', uuid: 'frame-1' } as const
    let recordedAtDispatch: string | undefined
    const dispatch = vi.fn(async () => {
      recordedAtDispatch = journal.submissions()[0]?.handedOverItemId
      return { state: 'admitted' as const }
    })
    const adapter: Pick<StructuredAgentSessionAdapter, 'dispatch' | 'mintDispatchIdentity'> = {
      dispatch,
      mintDispatchIdentity: () => identity
    }

    await handOverSubmission(
      {
        sessionId: 'session-1',
        journal,
        fence: 1,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: A hand-over calls only these two members.
        adapter: adapter as StructuredAgentSessionAdapter
      },
      journal.submissions()[0]!
    )

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ providerIdentity: identity }))
    expect(recordedAtDispatch).toBe(agentJournalItemKey(identity))
    await journal.close()
    const reopened = await journals.open({ identity: IDENTITY, journalDir: root })
    await reopened.markPendingSubmissionsUnknown(2)
    expect(reopened.submissions()[0]).toMatchObject({
      dispatchState: 'unknown',
      handedOverItemId: agentJournalItemKey(identity)
    })
  })
})

describe('the Claude adapter handing a send over', () => {
  it('writes the frame under the id the journal recorded for it', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const adapter = await acquired(claude)
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    await journal.appendSubmission({
      clientMessageId: 'cm-1',
      payloadFingerprint: 'fingerprint',
      body: USER_MESSAGE,
      fence: 7,
      handoverRecorded: true
    })

    await handOverSubmission(
      { sessionId: 'session-1', journal, fence: 7, adapter },
      journal.submissions()[0]!
    )

    const recorded = parseAgentJournalItemKey(journal.submissions()[0]?.handedOverItemId ?? '')
    const uuid =
      recorded?.provider === 'claude' && recorded.sessionId === PROVIDER_SESSION_ID
        ? recorded.uuid
        : null
    expect(uuid).toEqual(expect.any(String))
    expect(claude.connections[0]?.sent[0]).toMatchObject({ uuid })
  })
})
