// A withdrawn message's images go back into the composer. On a paired server they are files in that
// server's attachment store, so the chips must keep that owner: their previews read from the server
// and a later send is checked against it, never against this machine's disk.

// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { writeOutbox } from './structured-agent-session-outbox-storage'
import { useStructuredAgentSessionWithdrawnRestore } from './structured-agent-session-withdrawn-message-restore'
import {
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache
} from './use-native-chat-composer-attachments'

const SESSION = 'session-1'
const PANE = 'tab-1::session-1'
const STORED = '/srv/orca/agent-session-attachments/abc/u1/shot.png'
const WORKSPACE_IMAGE = '/remote/repo/diagram.png'

function withdrawn(): StructuredAgentSessionOutboxEntry {
  return {
    clientMessageId: 'message-1',
    sessionId: SESSION,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'image-ref', path: STORED },
        { type: 'image-ref', path: WORKSPACE_IMAGE },
        { type: 'text', text: 'look' }
      ]
    },
    previewUris: [],
    state: 'queued',
    queuedAt: 1,
    lastAttemptAt: null,
    retryAfterUnknownSubmittedAt: null
  }
}

beforeEach(() => {
  replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 7 }])
  writeOutbox(SESSION, [withdrawn()])
})

afterEach(() => {
  writeOutbox(SESSION, [])
  clearNativeChatAttachmentCacheForTests()
})

describe('withdrawn images from a chat on a paired server', () => {
  it('come back owned by the server store that holds them', () => {
    const { result } = renderHook(() =>
      useStructuredAgentSessionWithdrawnRestore(
        SESSION,
        { kind: 'environment', environmentId: 'env-1' },
        PANE
      )
    )
    result.current.byStop([withdrawn()])

    const chips = readNativeChatAttachmentCache(PANE)
    expect(chips.find((chip) => chip.path === STORED)?.hostOwner).toEqual({
      environmentId: 'env-1',
      pairingRevision: 7,
      sessionId: SESSION
    })
    // A workspace file keeps the checks it already had.
    expect(chips.find((chip) => chip.path === WORKSPACE_IMAGE)?.hostOwner).toBeUndefined()
  })

  it('come back unowned from a chat on this machine', () => {
    const { result } = renderHook(() =>
      useStructuredAgentSessionWithdrawnRestore(SESSION, { kind: 'local' }, PANE)
    )
    result.current.byStop([withdrawn()])

    expect(readNativeChatAttachmentCache(PANE).every((chip) => !chip.hostOwner)).toBe(true)
  })
})
