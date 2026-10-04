// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import {
  clearNativeChatHostOwnedReferencesForTests,
  recordNativeChatHostOwnedReferences
} from './native-chat-attachment-destination'
import { useNativeChatAttachmentSendGuard } from './use-native-chat-attachment-send-guard'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const SCOPE = 'pane-1'
const OWNER = { environmentId: 'env-1', pairingRevision: 7, sessionId: 'session-1' }
const STORED_IMAGE = '/srv/agent-session-attachments/s/u1/shot.png'
const STORED_FILE_REF = '@/srv/agent-session-attachments/s/u2/notes.md'

function transport(runtimeEnvironmentId: string | null): NativeChatStructuredComposerTransport {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard reads only sessionId and runtimeEnvironmentId.
  return { sessionId: 'session-1', runtimeEnvironmentId } as NativeChatStructuredComposerTransport
}

const storedChip: NativeChatComposerImageAttachment = {
  id: 'chip-1',
  path: STORED_IMAGE,
  hostOwner: OWNER
}
const workspaceChip: NativeChatComposerImageAttachment = { id: 'chip-2', path: '/wt/a.png' }

function harness(args: { runtimeEnvironmentId: string | null; draft: string }) {
  const calls = {
    sendStructured: vi.fn(),
    setDraft: vi.fn(),
    removeImageAttachment: vi.fn(),
    setNotice: vi.fn()
  }
  const { result } = renderHook(() =>
    useNativeChatAttachmentSendGuard({
      scopeKey: SCOPE,
      structuredTransport: transport(args.runtimeEnvironmentId),
      draft: args.draft,
      ...calls
    })
  )
  return { send: result.current, calls }
}

beforeEach(() => {
  replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 7 }])
  recordNativeChatHostOwnedReferences(SCOPE, [{ reference: STORED_FILE_REF, hostOwner: OWNER }])
})

afterEach(() => {
  clearNativeChatHostOwnedReferencesForTests()
})

describe('useNativeChatAttachmentSendGuard', () => {
  it('sends attachments stored for this chat on this server', () => {
    const draft = `see ${STORED_FILE_REF} `
    const { send, calls } = harness({ runtimeEnvironmentId: 'env-1', draft })
    send(draft, [storedChip, workspaceChip])
    expect(calls.sendStructured).toHaveBeenCalledExactlyOnceWith(draft, [storedChip, workspaceChip])
    expect(calls.setNotice).not.toHaveBeenCalled()
  })

  it('drops stored attachments and holds the send after the server was re-paired', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 8 }])
    const draft = `see ${STORED_FILE_REF} please`
    const { send, calls } = harness({ runtimeEnvironmentId: 'env-1', draft })
    send(draft, [storedChip, workspaceChip])
    expect(calls.sendStructured).not.toHaveBeenCalled()
    expect(calls.removeImageAttachment).toHaveBeenCalledExactlyOnceWith('chip-1')
    expect(calls.setDraft).toHaveBeenCalledExactlyOnceWith('see please')
    expect(calls.setNotice).toHaveBeenCalledWith(
      'This workspace changed hosts while attaching — drop the files again.'
    )
  })

  it('never sends a stored attachment to a chat on this machine', () => {
    const { send, calls } = harness({ runtimeEnvironmentId: null, draft: 'x' })
    send('x', [storedChip])
    expect(calls.sendStructured).not.toHaveBeenCalled()
    expect(calls.removeImageAttachment).toHaveBeenCalledExactlyOnceWith('chip-1')
  })

  it('ignores a stored reference the user already deleted from the draft', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 8 }])
    const { send, calls } = harness({ runtimeEnvironmentId: 'env-1', draft: 'plain text' })
    send('plain text', [workspaceChip])
    expect(calls.sendStructured).toHaveBeenCalledExactlyOnceWith('plain text', [workspaceChip])
  })
})
