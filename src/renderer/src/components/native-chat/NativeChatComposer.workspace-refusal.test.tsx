// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

// A bridge composer whose tab moved out of its supplied workspace must refuse before any send
// side effect: the draft, history and echo stay as they were, and no Escape is written.

const mocks = vi.hoisted(() => {
  const captured: {
    fieldProps: { onSend?: () => void; onStop?: () => void } | null
    tabsByWorktree: Record<string, TerminalTab[]>
  } = { fieldProps: null, tabsByWorktree: {} }
  return Object.assign(captured, {
    sendNativeChatMessage: vi.fn(),
    sendRuntimePtyInput: vi.fn(),
    setDraft: vi.fn(),
    trackPendingSend: vi.fn()
  })
})

vi.mock('../../store', () => {
  const state = {
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    agentStatusByPaneKey: {},
    get tabsByWorktree() {
      return mocks.tabsByWorktree
    },
    updateSettings: vi.fn(),
    clearNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchDraftAdopted: vi.fn()
  }
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false,
  sendRuntimePtyInput: (...args: unknown[]) => mocks.sendRuntimePtyInput(...args)
}))
vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeRuntimeOwnerModule>()),
  getSettingsForWorktreeRuntimeOwner: () => ({ activeRuntimeEnvironmentId: null })
}))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => mocks.sendNativeChatMessage(...args),
  sendNativeChatTypedCommand: vi.fn(),
  sendNativeChatMessageVerified: vi.fn(),
  typeNativeChatCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-session-option-discovery', () => ({
  resolveNativeChatModelDiscoveryContext: () => null,
  discoverNativeChatCatalogModels: async () => null
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('./use-native-chat-draft', () => ({
  useNativeChatDraft: () => ({
    draft: 'hello',
    setDraft: mocks.setDraft,
    flushDraftAppends: () => {}
  })
}))
vi.mock('./NativeChatComposerField', () => ({
  NativeChatComposerField: (props: { onSend?: () => void; onStop?: () => void }) => {
    mocks.fieldProps = props
    return null
  }
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'idle', skills: [], error: null, retry: () => {} })
}))
vi.mock('./use-native-chat-composer-attachments', () => ({
  useNativeChatComposerAttachments: () => ({
    imageAttachments: [],
    pendingChips: { begin: vi.fn(), resolve: vi.fn(), drop: vi.fn(), attachReferences: vi.fn() },
    attachResolvedPaths: vi.fn(),
    clearImageAttachments: vi.fn(),
    flushPendingAttachments: vi.fn(),
    removeImageAttachment: vi.fn()
  })
}))
vi.mock('./use-native-chat-external-attachments', () => ({
  useNativeChatExternalAttachments: () => ({
    attachExternalPaths: vi.fn(),
    resolveAttachmentOwner: vi.fn()
  })
}))
vi.mock('./use-native-chat-composer-paste', () => ({
  useNativeChatComposerPaste: () => ({ handlePaste: vi.fn(), pasteFromClipboard: vi.fn() })
}))
vi.mock('./use-native-chat-file-attachment-actions', () => ({
  useNativeChatFileAttachmentActions: () => ({ pickAttachments: vi.fn() })
}))
vi.mock('../dictation/dictation-control-events', () => ({ dispatchDictationControl: vi.fn() }))
vi.mock('./use-native-chat-composer-keydown', () => ({
  useNativeChatComposerKeyDown: () => vi.fn()
}))
vi.mock('./use-native-chat-send-lifecycle', () => ({
  useNativeChatSendLifecycle: () => ({
    cancelPendingSends: vi.fn(),
    trackPendingSend: mocks.trackPendingSend
  })
}))

import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'
import { NativeChatComposer } from './NativeChatComposer'
import { terminalTabFixture } from './native-chat-workspace-test-fixtures'

function renderComposer(props: {
  onOptimisticSend?: () => string
  onSubmitted?: () => void
}): void {
  render(
    <NativeChatComposer
      terminalTabId="tab-1"
      worktreeId="wt-1"
      paneKey="tab-1:leaf-1"
      targetPtyId="pty-1"
      agent="codex"
      {...props}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fieldProps = null
  mocks.sendNativeChatMessage.mockReturnValue({ cancel: vi.fn(), settleAfterMs: 0 })
})

afterEach(cleanup)

describe('NativeChatComposer workspace membership', () => {
  it('sends while the tab is in its supplied workspace', () => {
    mocks.tabsByWorktree = { 'wt-1': [terminalTabFixture('tab-1', 'wt-1')] }
    renderComposer({})
    act(() => mocks.fieldProps?.onSend?.())
    expect(mocks.sendNativeChatMessage).toHaveBeenCalledOnce()
  })

  describe('when the bridge tab is no longer in its supplied workspace', () => {
    beforeEach(() => {
      // Moved, not closed: a global search would find it and send to wt-2's host.
      mocks.tabsByWorktree = { 'wt-1': [], 'wt-2': [terminalTabFixture('tab-1', 'wt-2')] }
    })

    it('refuses the send before any optimistic or input side effect', () => {
      const onOptimisticSend = vi.fn(() => 'pending-1')
      const onSubmitted = vi.fn()
      renderComposer({ onOptimisticSend, onSubmitted })

      act(() => mocks.fieldProps?.onSend?.())

      expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
      expect(onOptimisticSend).not.toHaveBeenCalled()
      expect(onSubmitted).not.toHaveBeenCalled()
      expect(mocks.setDraft).not.toHaveBeenCalled()
      expect(mocks.trackPendingSend).not.toHaveBeenCalled()
    })

    it('sends no idle Escape interrupt', () => {
      renderComposer({})
      act(() => mocks.fieldProps?.onStop?.())
      expect(mocks.sendRuntimePtyInput).not.toHaveBeenCalled()
    })
  })
})
