// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  createStructuredAgentSessionOutboxEntry,
  structuredAgentSessionSendRequest
} from '../../../../shared/structured-agent-session-outbox'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import { readNativeChatAttachmentCache } from './use-native-chat-composer-attachments'
import {
  resetStructuredAgentSessionChatLinesForTests,
  returnStructuredAgentSessionMessage,
  setStructuredAgentSessionChatLine,
  useStructuredAgentSessionChatLine
} from './structured-agent-session-returned-send'

const SCOPE = structuredAgentSessionDraftScopeKey('session-1')

function entry(text: string, images: string[] = []) {
  return createStructuredAgentSessionOutboxEntry({
    clientMessageId: `id-${text}`,
    sessionId: 'session-1',
    text,
    attachments: images.map((path) => ({ path, previewUri: `file://${path}` })),
    queuedAt: 1
  })
}

beforeEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  resetStructuredAgentSessionChatLinesForTests()
})

afterEach(() => {
  clearNativeChatDraftCacheForTests()
})

describe("a message given back to its conversation's draft", () => {
  it('lands after what is typed, after a blank line, with no composer open', () => {
    writeNativeChatDraftCache(SCOPE, 'typed')
    returnStructuredAgentSessionMessage(entry('returned'))
    expect(readNativeChatDraftCache(SCOPE)).toBe('typed\n\nreturned')
  })

  // A crash between the hand-back and the outbox save repeats it; the repeat adds nothing.
  it('adds nothing the second time, text or images', () => {
    const message = entry('returned', ['/tmp/a.png'])
    returnStructuredAgentSessionMessage(message)
    returnStructuredAgentSessionMessage(message)
    expect(readNativeChatDraftCache(SCOPE)).toBe('returned')
    expect(readNativeChatAttachmentCache(SCOPE).map((image) => image.path)).toEqual(['/tmp/a.png'])
  })

  it('goes to the conversation, not to any other chat', () => {
    returnStructuredAgentSessionMessage(entry('mine'))
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey('session-2'))).toBe('')
  })
})

describe('the chat line', () => {
  it('says why once, to its own chat, until cleared', () => {
    const mine = renderHook(() => useStructuredAgentSessionChatLine('session-1'))
    const other = renderHook(() => useStructuredAgentSessionChatLine('session-2'))
    act(() => setStructuredAgentSessionChatLine('session-1', ['messageNotSaved', 'tryAgain']))
    expect(mine.result.current).toBe("Couldn't save your message. Try again.")
    expect(other.result.current).toBeNull()
    act(() => setStructuredAgentSessionChatLine('session-1', null))
    expect(mine.result.current).toBeNull()
  })

  it('is there for a chat that opens after its words were set', () => {
    setStructuredAgentSessionChatLine('session-1', ['sendOutcomeLost'])
    const opened = renderHook(() => useStructuredAgentSessionChatLine('session-1'))
    expect(opened.result.current).toBe(
      "Orca couldn't confirm your message reached the agent. Check the chat, then send it again if needed."
    )
  })
})

describe('an SSH image handed back', () => {
  it('keeps the connection it was uploaded to, across a reload, and never sends it', () => {
    const sent = createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'id-remote',
      sessionId: 'session-1',
      text: 'look at this',
      attachments: [
        { path: '/home/remote/.orca/paste/a.png', previewUri: 'blob:a', connectionId: 'ssh-1' },
        { path: '/repo/local.png', previewUri: 'blob:b' }
      ],
      queuedAt: 1
    })
    expect(JSON.stringify(structuredAgentSessionSendRequest(sent, 1))).not.toContain('ssh-1')
    writeOutbox('session-1', [sent])
    const [saved] = readOutbox('session-1')

    returnStructuredAgentSessionMessage(saved!)
    expect(readNativeChatAttachmentCache(SCOPE)).toEqual([
      expect.objectContaining({ path: '/home/remote/.orca/paste/a.png', connectionId: 'ssh-1' }),
      expect.not.objectContaining({ connectionId: expect.anything() })
    ])
  })
})
