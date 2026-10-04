// @vitest-environment happy-dom

// A message an older build saved behind its Retry is never sent again and never drawn as one this
// client is sending: its surface is the host's row, if the journal has one, or the composer it
// comes back to. So nothing reads "Sending…" for it, not even until the journal loads.

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { resetStructuredAgentSessionChatLinesForTests } from './structured-agent-session-returned-send'

const SCOPE = structuredAgentSessionDraftScopeKey('session-1')
const ID = 'legacy'

type Props = { submissions: AgentJournalSubmission[]; journalCursor: AgentJournalCursor | null }

afterEach(cleanup)

// An older build's held-for-Retry entry: read back as one only the journal settles.
const OLDER_BUILD_FIELDS: Record<string, unknown> = {
  state: 'queued',
  lastFailure: { kind: 'failed' }
}

beforeEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  resetStructuredAgentSessionChatLinesForTests()
  mocks.call.mockReset()
  writeOutbox('session-1', [
    {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: ID,
        sessionId: 'session-1',
        text: 'saved behind a Retry',
        attachments: [],
        queuedAt: 1
      }),
      lastAttemptAt: 5,
      ...OLDER_BUILD_FIELDS
    }
  ])
})

function mount(initialProps: Props) {
  return renderHook(
    (props: Props) =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: { kind: 'local' },
        fence: 1,
        submissions: props.submissions,
        journalCursor: props.journalCursor
      }),
    { initialProps }
  )
}

function row(): AgentJournalSubmission {
  return {
    clientMessageId: ID,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 1
  }
}

const ROW_ITEM: AgentJournalRenderItem = {
  itemId: agentJournalSubmissionKey(ID),
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'saved behind a Retry' }] }
}

describe('a message an older build saved behind its Retry', () => {
  it('is drawn nowhere and says nothing before the journal loads', () => {
    const view = mount({ submissions: [], journalCursor: null })
    const outbox = view.result.current.outbox
    expect(outbox).toMatchObject([{ clientMessageId: ID, legacyUnsettled: true }])

    expect(projectStructuredAgentSessionMessages([], outbox, [])).toEqual([])
    expect(structuredAgentSessionDeliveryNotices(outbox, 'Claude', [], [])).toEqual(new Map())
  })

  it('comes back to the composer once the journal loads with no row for it', () => {
    const view = mount({ submissions: [], journalCursor: null })
    view.rerender({ submissions: [], journalCursor: { epoch: 'e', sequence: 2 } })
    expect(view.result.current.outbox).toEqual([])
    expect(readNativeChatDraftCache(SCOPE)).toBe('saved behind a Retry')
  })

  it("is the host's row once the journal shows one, and no second bubble", () => {
    const view = mount({ submissions: [], journalCursor: null })
    const before = view.result.current.outbox
    // Even drawn against the row before the outbox drops it, the row is the only bubble.
    expect(
      projectStructuredAgentSessionMessages([ROW_ITEM], before, [row()]).map(
        (message) => message.id
      )
    ).toEqual([agentJournalSubmissionKey(ID)])

    view.rerender({ submissions: [row()], journalCursor: { epoch: 'e', sequence: 2 } })
    expect(view.result.current.outbox).toEqual([])
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
  })
})
