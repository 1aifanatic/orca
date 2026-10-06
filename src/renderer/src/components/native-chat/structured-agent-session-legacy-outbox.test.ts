// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'

const mocks = vi.hoisted(() => ({
  outline: vi.fn(),
  handBack: vi.fn((): boolean => true),
  notice: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  readStructuredAgentSessionConversationOutline: mocks.outline
}))
vi.mock('./structured-agent-session-message-hand-back', () => ({
  handBackStructuredAgentSessionMessage: mocks.handBack
}))
vi.mock('./structured-agent-session-pending-sends', () => ({
  setStructuredAgentSessionSendNotice: mocks.notice
}))

import { recoverLegacyStructuredAgentSessionOutbox } from './structured-agent-session-legacy-outbox'

const SESSION = 'session-1'
const KEY = `orca:desktopStructuredAgentSessionOutbox:v1:${SESSION}`
const target = { kind: 'local' } as const

function saved(clientMessageId: string, text: string) {
  return {
    clientMessageId,
    sessionId: SESSION,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    previewUris: [],
    state: 'unconfirmed',
    queuedAt: 1,
    lastAttemptAt: 1,
    retryAfterUnknownSubmittedAt: null
  }
}

function outline(ids: string[], omittedEntries = 0) {
  return {
    sessionId: SESSION,
    cursor: { epoch: 'e', sequence: 9 },
    entries: ids.map((id, index) => ({
      itemId: agentJournalSubmissionKey(id),
      sequence: index,
      preview: id,
      imageCount: 0
    })),
    omittedEntries
  }
}

function recover(args: {
  submissions?: AgentJournalSubmission[]
  queuedMessageIds?: string[]
}): Promise<void> {
  return recoverLegacyStructuredAgentSessionOutbox({
    sessionId: SESSION,
    target,
    submissions: args.submissions ?? [],
    queuedMessageIds: args.queuedMessageIds ?? []
  })
}

describe('a chat an older build left messages for', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.outline.mockReset()
    mocks.handBack.mockClear()
    mocks.handBack.mockReturnValue(true)
    mocks.notice.mockClear()
  })
  afterEach(() => localStorage.clear())

  it('gives back only what the host holds nowhere, never sends, and deletes the copy', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        saved('drawn', 'in the chat'),
        saved('card', 'a card'),
        saved('lost', 'gone')
      ])
    )
    mocks.outline.mockResolvedValue(outline(['drawn']))
    await recover({ queuedMessageIds: ['card'] })
    expect(mocks.handBack).toHaveBeenCalledExactlyOnceWith(SESSION, 'lost', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'gone' }]
    })
    expect(mocks.notice).toHaveBeenCalledWith(SESSION, 'Your message was not sent. Send it again.')
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('says it could not confirm when the host cannot list the whole chat', async () => {
    localStorage.setItem(KEY, JSON.stringify([saved('maybe', 'maybe sent')]))
    mocks.outline.mockResolvedValue(outline([], 3))
    await recover({})
    expect(mocks.handBack).toHaveBeenCalledOnce()
    expect(mocks.notice).toHaveBeenCalledWith(
      SESSION,
      expect.stringContaining("couldn't confirm your message reached the agent")
    )
  })

  it('keeps the copy for the next open when the text could not be saved back', async () => {
    localStorage.setItem(KEY, JSON.stringify([saved('lost', 'gone')]))
    mocks.outline.mockResolvedValue(null)
    mocks.handBack.mockReturnValue(false)
    await recover({})
    expect(localStorage.getItem(KEY)).not.toBeNull()
  })

  it('drops a message the host already has a row for', async () => {
    localStorage.setItem(KEY, JSON.stringify([saved('row', 'recorded')]))
    mocks.outline.mockRejectedValue(new Error('offline'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the id is read.
    await recover({ submissions: [{ clientMessageId: 'row' } as AgentJournalSubmission] })
    expect(mocks.handBack).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})
