// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatComposerFieldProps } from './NativeChatComposerField'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

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
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { onFileDrop: () => vi.fn() } }
  })
})
afterEach(cleanup)

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
    expect(mocks.fieldProps?.sendDisabledReason).toContain('Codex Accounts settings.')
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
    view.rerender(composer(null))
    expect(mocks.fieldProps?.sendButtonDisabled).toBe(false)
    expect(mocks.fieldProps?.sendDisabledReason).toBeUndefined()
    await act(async () => mocks.fieldProps?.onSend?.())
    expect(dispatchCommand).toHaveBeenCalledWith('hello')
    expect(send).toHaveBeenCalledWith('hello', [])
    expect(mocks.sendPty).not.toHaveBeenCalled()
    expect(mocks.setDraft).toHaveBeenCalledWith('')
  })
})
