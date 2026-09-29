// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { requestNativeChatOverlayPaste } from '@/lib/native-chat-paste-request'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import type { NativeChatComposerHandle } from './NativeChatComposer'
import { registerTerminalPanePasteListeners } from '../terminal-pane/terminal-pane-paste-listeners'
import type { TerminalPaneCloseController } from '../terminal-pane/use-terminal-pane-close-actions'
import type { TerminalPanePasteExecution } from '../terminal-pane/terminal-pane-paste-execution'
import {
  pasteTerminalPaneMenuClipboard,
  type TerminalPaneMenuPasteContext
} from '../terminal-pane/terminal-pane-menu-paste'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'

const mocks = vi.hoisted(() => ({
  clipboardEventRequired: false,
  readClipboardText: vi.fn(),
  terminalClipboard: vi.fn(),
  error: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../terminal-pane/terminal-clipboard-paste', () => ({
  pasteTerminalClipboard: mocks.terminalClipboard
}))
vi.mock('../terminal-pane/terminal-clipboard-event-paste', () => ({
  isClipboardEventPasteRequired: () => mocks.clipboardEventRequired,
  firesNativePasteEvent: () => true,
  getClipboardEventText: (event: ClipboardEvent) => event.clipboardData?.getData('text/plain') ?? ''
}))

let dispose: (() => void) | undefined
beforeEach(() => {
  mocks.clipboardEventRequired = false
  mocks.readClipboardText.mockResolvedValue('menu text')
  mocks.terminalClipboard.mockResolvedValue({ status: 'empty' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { readClipboardText: mocks.readClipboardText } }
  })
})
afterEach(() => {
  cleanup()
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  vi.clearAllMocks()
})

function composer(): NativeChatComposerHandle {
  return {
    focus: vi.fn(() => true),
    insertTypedText: vi.fn(() => true),
    handlePasteEvent: vi.fn(),
    pasteFromClipboard: vi.fn()
  }
}

function fixture(options: { chat?: boolean; ready?: boolean; platform?: NodeJS.Platform } = {}) {
  const container = document.createElement('div')
  const paneContainer = document.createElement('div')
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  paneContainer.append(textarea)
  const root = document.createElement('div')
  root.dataset.nativeChatRoot = 'true'
  if (options.chat !== false) {
    paneContainer.append(root)
  }
  container.append(paneContainer)
  const otherContainer = document.createElement('div')
  container.append(otherContainer)
  document.body.append(container)
  const input = composer()
  const composerRef = { current: options.ready === false ? null : input }
  const questionAnswerInputRef: { current: HTMLInputElement | null } = { current: null }
  renderHook(() =>
    useNativeChatPasteBridge({ rootRef: { current: root }, composerRef, questionAnswerInputRef })
  )
  const pane = { id: 1, leafId: 'one', container: paneContainer }
  const otherPane = { id: 2, leafId: 'two', container: otherContainer }
  const pasteFromClipboard = vi.fn()
  const executePanePasteText = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listeners use only these controller fields.
  const controller = {
    forceBracketedMultilineTextPaste: false,
    keybindings: {},
    worktreeId: 'workspace',
    managerRef: { current: { getActivePane: () => otherPane, getPanes: () => [pane, otherPane] } },
    setTerminalError: vi.fn()
  } as unknown as TerminalPaneCloseController
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the two execution callbacks read by the listener.
  const execution = {
    pasteFromClipboard,
    executePanePasteText
  } as unknown as TerminalPanePasteExecution
  dispose = registerTerminalPanePasteListeners({
    container,
    controller,
    execution,
    isMac: options.platform === 'darwin',
    shortcutPlatform: options.platform ?? 'win32'
  })
  textarea.focus()
  return {
    root,
    textarea,
    pane,
    input,
    composerRef,
    questionAnswerInputRef,
    pasteFromClipboard,
    executePanePasteText
  }
}

function paste(target: Element, text = 'event text') {
  const data = new DataTransfer()
  data.setData('text/plain', text)
  const event = new ClipboardEvent('paste', {
    clipboardData: data,
    bubbles: true,
    cancelable: true
  })
  target.dispatchEvent(event)
  return event
}

describe('chat paste surface ownership', () => {
  it('routes event payload to the originating pane rather than the active terminal', () => {
    const f = fixture()
    const event = paste(f.textarea, '원문')
    expect(event.defaultPrevented).toBe(true)
    expect(f.input.handlePasteEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ clipboardData: event.clipboardData })
    )
    expect(f.input.pasteFromClipboard).not.toHaveBeenCalled()
    expect(mocks.readClipboardText).not.toHaveBeenCalled()
    expect(f.pasteFromClipboard).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'win32', 'linux'] as const)(
    'routes %s keyboard paste to chat once',
    (platform) => {
      const f = fixture({ platform })
      f.textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'v',
          metaKey: platform === 'darwin',
          ctrlKey: platform !== 'darwin',
          bubbles: true,
          cancelable: true
        })
      )
      paste(f.textarea)
      expect(f.input.pasteFromClipboard).toHaveBeenCalledTimes(1)
      expect(f.input.handlePasteEvent).not.toHaveBeenCalled()
      expect(f.pasteFromClipboard).not.toHaveBeenCalled()
    }
  )

  it('uses native event data in paired web without requesting clipboard permission', () => {
    mocks.clipboardEventRequired = true
    const f = fixture()
    f.textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true })
    )
    paste(f.textarea)
    expect(f.input.handlePasteEvent).toHaveBeenCalledTimes(1)
    expect(f.input.pasteFromClipboard).not.toHaveBeenCalled()
    expect(f.pasteFromClipboard).not.toHaveBeenCalled()
  })

  it('routes the app menu to the chat above the focused terminal', () => {
    const f = fixture()
    window.dispatchEvent(new Event(APP_MENU_PASTE_EVENT, { cancelable: true }))
    expect(f.input.pasteFromClipboard).toHaveBeenCalledTimes(1)
    expect(mocks.terminalClipboard).not.toHaveBeenCalled()
  })

  it('keeps unavailable chat from falling through to a hidden terminal', () => {
    const f = fixture({ ready: false })
    paste(f.textarea)
    expect(f.pasteFromClipboard).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledTimes(1)
  })

  it('preserves terminal-only paste', () => {
    const f = fixture({ chat: false })
    paste(f.textarea)
    expect(f.pasteFromClipboard).toHaveBeenCalledTimes(1)
    expect(f.input.pasteFromClipboard).not.toHaveBeenCalled()
    expect(f.input.handlePasteEvent).not.toHaveBeenCalled()
  })

  it('keeps search fields inside chat on native paste', () => {
    const f = fixture()
    const search = document.createElement('input')
    f.root.append(search)
    expect(paste(search).defaultPrevented).toBe(false)
    search.focus()
    window.dispatchEvent(new Event(APP_MENU_PASTE_EVENT, { cancelable: true }))
    expect(f.input.pasteFromClipboard).not.toHaveBeenCalled()
    expect(f.input.handlePasteEvent).not.toHaveBeenCalled()
  })

  it('hands the event to the question answer when the composer is absent', async () => {
    const f = fixture({ ready: false })
    const answer = document.createElement('input')
    f.root.append(answer)
    f.questionAnswerInputRef.current = answer
    await act(async () => {
      paste(f.textarea, 'answer')
    })
    expect(answer.value).toBe('answer')
    expect(f.pasteFromClipboard).not.toHaveBeenCalled()
  })

  it('does not put a late menu read into a replacement question input', async () => {
    const f = fixture({ ready: false })
    const answer = document.createElement('input')
    f.root.append(answer)
    f.questionAnswerInputRef.current = answer
    let finish = (_text: string): void => {}
    mocks.readClipboardText.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve
      })
    )
    requestNativeChatOverlayPaste(f.pane.container)
    f.questionAnswerInputRef.current = document.createElement('input')
    await act(async () => finish('old answer'))
    expect(answer.value).toBe('')
    expect(f.questionAnswerInputRef.current.value).toBe('')
  })

  it('routes context-menu paste by its named pane', async () => {
    const f = fixture()
    const context: TerminalPaneMenuPasteContext = {
      managerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      tabId: 'tab',
      worktreeId: 'workspace',
      forceBracketedMultilineTextPaste: false,
      onPasteError: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: chat routing needs only the pane container.
    await pasteTerminalPaneMenuClipboard(context, f.pane as unknown as ManagedPane, 'context-menu')
    expect(f.input.pasteFromClipboard).toHaveBeenCalledTimes(1)
    expect(mocks.terminalClipboard).not.toHaveBeenCalled()
  })
})
