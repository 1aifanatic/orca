// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatComposerFieldProps } from './NativeChatComposerField'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { nativeChatComposerSendState } from './native-chat-composer-send-state'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'

const mocks = vi.hoisted(() => {
  function emptyField(): NativeChatComposerFieldProps | null {
    return null
  }
  return { fieldProps: emptyField(), setDraft: vi.fn(), sendPty: vi.fn() }
})

vi.mock('../../store', () => {
  const state = {
    dictationState: 'idle',
    settings: { voice: { enabled: false } },
    updateSettings: vi.fn()
  }
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: vi.fn()
}))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: mocks.sendPty
}))
vi.mock('./use-native-chat-draft', () => ({
  useNativeChatDraft: () => ({
    draft: 'hello',
    setDraft: mocks.setDraft,
    flushDraftAppends: vi.fn()
  })
}))
vi.mock('./native-chat-draft-cache', () => ({ readNativeChatDraftCache: () => '' }))
vi.mock('./NativeChatComposerField', () => ({
  NativeChatComposerField: (props: NativeChatComposerFieldProps) => {
    mocks.fieldProps = props
    return <div data-testid="composer-field" onKeyDown={props.onKeyDown} />
  }
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: vi.fn() })
}))
vi.mock('./use-native-chat-composer-attachments', () => ({
  useNativeChatComposerAttachments: () => ({
    imageAttachments: [],
    attachResolvedPaths: vi.fn(),
    clearImageAttachments: vi.fn(),
    flushPendingAttachments: vi.fn(),
    removeImageAttachment: vi.fn()
  })
}))
vi.mock('./use-native-chat-composer-paste', () => ({
  useNativeChatComposerPaste: () => ({ handlePaste: vi.fn(), pasteFromClipboard: vi.fn() })
}))
vi.mock('./use-native-chat-external-attachments', () => ({
  useNativeChatExternalAttachments: () => ({
    attachExternalPaths: vi.fn(),
    resolveAttachmentOwner: vi.fn()
  })
}))
vi.mock('./use-native-chat-session-options', () => ({
  useNativeChatSessionOptions: () => ({ surface: null, snapshot: [] })
}))

import { NativeChatComposer } from './NativeChatComposer'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fieldProps = null
  clearNativeChatComposerDraftsForTests()
  updateNativeChatComposerDraft('tab-1:structured', { text: 'hello' }, 'immediate')
  mocks.setDraft.mockImplementation((text: string) => {
    updateNativeChatComposerDraft('tab-1:structured', { text }, 'immediate')
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { onFileDrop: () => vi.fn() } }
  })
})
afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
})

describe('structured composer Send availability', () => {
  it('blocks signed-out click and keyboard sends, retains the draft, and sends after recovery', async () => {
    const send = vi.fn(() => true)
    const dispatchCommand = vi.fn(async () => ({ handled: false, accepted: false, error: null }))
    const composer = (unavailable: NativeChatStructuredComposerTransport['unavailable']) => (
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:structured"
        targetPtyId={null}
        agent="codex"
        structuredTransport={{
          unavailable,
          send,
          dispatchCommand,
          optionsSurface: {
            getSnapshot: () => [],
            setOption: vi.fn(),
            invokeAction: vi.fn(),
            subscribe: () => () => {}
          },
          optionSnapshot: [],
          onError: vi.fn(),
          runtime: 'local',
          sessionId: 'session-test',
          runtimeEnvironmentId: null
        }}
      />
    )
    const view = render(composer({ reason: 'notSignedIn', account: 'managed' }))
    expect(mocks.fieldProps?.sendButtonDisabled).toBe(true)
    expect(mocks.fieldProps?.sendBlockedReason).toContain('Codex Accounts settings.')
    await act(async () => mocks.fieldProps?.onSend?.())
    await act(async () => {
      fireEvent.keyDown(view.getByTestId('composer-field'), { key: 'Enter' })
      fireEvent.keyDown(view.getByTestId('composer-field'), {
        key: 'Enter',
        ctrlKey: true,
        metaKey: true
      })
    })
    expect(send).not.toHaveBeenCalled()
    expect(mocks.setDraft).not.toHaveBeenCalledWith('')
    expect(readNativeChatComposerDraft('tab-1:structured').text).toBe('hello')
    view.rerender(composer(null))
    expect(mocks.fieldProps?.sendButtonDisabled).toBe(false)
    expect(mocks.fieldProps?.sendBlockedReason).toBeUndefined()
    await act(async () => mocks.fieldProps?.onSend?.())
    expect(dispatchCommand).toHaveBeenCalledWith('hello')
    expect(send).toHaveBeenCalledWith('hello', [])
    expect(mocks.sendPty).not.toHaveBeenCalled()
    expect(mocks.setDraft).toHaveBeenCalledWith('')
  })
})

describe('combined attachment and account Send state', () => {
  const input = { agent: 'codex', isWorking: false, hasPty: true, disabled: false } as const
  const image = { id: 'image-1', path: '', unavailableName: 'photo.png' }

  it('keeps an unavailable image blocked after sign-in recovers, until it is removed', () => {
    const signedOut = nativeChatComposerSendState(input, 'hello', [image], {
      reason: 'notSignedIn',
      account: 'managed'
    })
    expect(signedOut.sendButtonDisabled).toBe(true)
    expect(signedOut.sendBlockedReason).toContain('Codex Accounts settings.')
    const signedIn = nativeChatComposerSendState(input, 'hello', [image], null)
    expect(signedIn.sendButtonDisabled).toBe(true)
    expect(signedIn.sendBlockedReason).toBe("An image couldn't be brought back. Remove it to send.")
    expect(nativeChatComposerSendState(input, 'hello', [], null)).toEqual({
      sendButtonDisabled: false,
      sendBlockedReason: undefined
    })
  })

  it('still requires sign-in after the unavailable image is removed', () => {
    const state = nativeChatComposerSendState(input, 'hello', [], {
      reason: 'notSignedIn',
      account: 'managed'
    })
    expect(state.sendButtonDisabled).toBe(true)
    expect(state.sendBlockedReason).toContain('Codex Accounts settings.')
  })

  it('keeps pending images blocked without an action tooltip', () => {
    expect(
      nativeChatComposerSendState(
        input,
        'hello',
        [{ id: 'pending', path: '', pending: true }],
        null
      )
    ).toEqual({ sendButtonDisabled: true, sendBlockedReason: undefined })
  })

  it('allows Stop while an image and the account are unavailable', () => {
    const state = nativeChatComposerSendState(
      { ...input, isWorking: true, onStop: vi.fn() },
      'hello',
      [image],
      { reason: 'notSignedIn', account: 'managed' }
    )
    expect(state.sendButtonDisabled).toBe(false)
  })
})
