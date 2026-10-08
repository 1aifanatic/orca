// @vitest-environment happy-dom
import { createRef, useRef } from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import { attachNativeChatSessionAttachmentPaths } from './native-chat-session-attachment-drop'
import { moveStructuredAgentSessionDraft } from './structured-agent-session-draft-move'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey as scope,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import {
  clearNativeChatPendingAttachmentsForTests,
  nativeChatPendingAttachmentSnapshot
} from './native-chat-pending-attachment-cache'

// Only host replies are controlled; pending-chip ownership and upload completion are production code.
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async () => ({
    runtimeId: 'paired-host',
    capabilities: ['agent-session.attachments.v1']
  }))
}))
let previousApi: typeof window.api
beforeEach(async () => {
  previousApi = window.api
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})
afterEach(async () => {
  cleanup()
  await nativeChatComposerDraftWritesSettled()
  clearNativeChatPendingAttachmentsForTests()
  clearNativeChatComposerDraftsForTests()
  window.api = previousApi
})
async function uploadFixture(
  extension: string,
  { removed = false, withSkill = false, move = true } = {}
) {
  const path = `/srv/agent-session-attachments/u1/report.${extension}`
  const sourcePath = `/local/report.${extension}`
  let finish = () => {}
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      fs: {
        uploadPathsToAgentSessionAttachments: () =>
          new Promise((resolve) => {
            finish = () => resolve({ uploaded: [{ sourcePath, path }], skipped: [], failed: [] })
          })
      }
    }
  })
  updateNativeChatComposerDraft(
    scope('a'),
    {
      text: withSkill ? '$review-long' : 'next question',
      ...(withSkill
        ? {
            document: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'nativeChatSkill', attrs: { token: '$review' } },
                    { type: 'text', text: '-long' }
                  ]
                }
              ]
            }
          }
        : {})
    },
    'immediate'
  )
  const view = renderHook(() => {
    const textareaRef = useRef(null)
    return useNativeChatComposerAttachments({
      attachmentScopeKey: scope('a'),
      allowWithoutTarget: true,
      caret: 0,
      disabled: false,
      isComposing: () => false,
      resolveTarget: () => null,
      textareaRef,
      setCaret: () => {},
      setDraft: (updater) =>
        updateNativeChatComposerDraft(
          scope('a'),
          { text: updater(readNativeChatComposerDraft(scope('a')).text) },
          'immediate'
        ),
      setNotice: () => {}
    })
  })
  let uploaded = Promise.resolve()
  act(() => {
    uploaded = attachNativeChatSessionAttachmentPaths({
      paths: [sourcePath],
      owner: {
        kind: 'runtime-session',
        environmentId: 'paired',
        sessionId: 'a',
        pairingRevision: 1
      },
      chips: view.result.current.pendingChips,
      isAbandoned: () => false,
      ownerStillCurrent: () => true,
      setNotice: () => {}
    })
  })
  await Promise.resolve()
  await Promise.resolve()
  const chip = nativeChatPendingAttachmentSnapshot(scope('a'))[0]
  if (!chip) {
    throw new Error('Expected pending upload chip')
  }
  expect(chip.pendingName).toBe(`report.${extension}`)
  const targetScope = scope(move ? 'b' : 'a')
  if (move) {
    act(() => moveStructuredAgentSessionDraft('a', 'b'))
  }
  expect(nativeChatPendingAttachmentSnapshot(targetScope)).toMatchObject([
    { id: chip.id, pendingName: `report.${extension}` }
  ])
  if (removed) {
    act(() => view.result.current.removeImageAttachment(chip.id))
  }
  view.unmount()
  finish()
  await uploaded
  return {
    path,
    targetScope,
    source: readNativeChatComposerDraft(scope('a')),
    target: readNativeChatComposerDraft(targetScope),
    pending: nativeChatPendingAttachmentSnapshot(targetScope)
  }
}
it('a moved paired PDF upload settles its reference into the replacement draft', async () => {
  const result = await uploadFixture('pdf')
  expect(result.pending).toEqual([])
  expect(result.target.text).toContain(`@${result.path}`)
  expect(result.source.text).toBe('')
})
it('control: a moved paired image upload settles into the replacement draft', async () => {
  const result = await uploadFixture('png')
  expect(result.pending).toEqual([])
  expect(result.target.text).toBe('next question')
  expect(result.target.images).toHaveLength(1)
  expect(result.target.images[0].path).toBe(result.path)
  expect(result.source.text).toBe('')
})

it('does not attach a moved file reference the user removed while uploading', async () => {
  const result = await uploadFixture('pdf', { removed: true })
  expect(result.pending).toEqual([])
  expect(result.target.text).toBe('next question')
  expect(result.source.text).toBe('')
})

it.each([
  { extension: 'pdf', move: true },
  { extension: 'png', move: true },
  { extension: 'pdf', move: false },
  { extension: 'png', move: false }
])(
  'preserves picked skills after $extension upload with move=$move',
  async ({ extension, move }) => {
    const result = await uploadFixture(extension, { withSkill: true, move })
    expect(result.pending).toEqual([])
    if (move) {
      expect(result.source.text).toBe('')
    }
    const inputRef = createRef<NativeChatComposerInput>()
    const view = render(
      <NativeChatPromptEditor
        scopeKey={result.targetScope}
        inputRef={inputRef}
        initialValue={result.target.text}
        disabled={false}
        placeholder="Message"
        onChange={() => {}}
        onSelect={() => {}}
      />
    )
    expect(inputRef.current?.value).toContain('$review-long')
    if (extension === 'pdf') {
      expect(inputRef.current?.value).toContain(`@${result.path}`)
    } else {
      expect(result.target.images[0]?.path).toBe(result.path)
    }
    await vi.waitFor(() => {
      expect(view.container.querySelectorAll('[data-native-chat-skill]')).toHaveLength(1)
      expect(view.container.querySelector('[data-native-chat-skill]')?.textContent).toBe('Review')
    })
  }
)
