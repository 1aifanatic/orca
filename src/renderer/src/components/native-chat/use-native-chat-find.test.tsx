// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { dispatchAppMenuPasteEvent } from '@/lib/app-menu-paste'
import { findOwnedTextControlPasteTarget } from '@/lib/text-control-paste-ownership'
import { isMacPlatform } from './native-chat-shortcut'
import { NativeChatFindBar } from './NativeChatFindBar'
import { useNativeChatFind } from './use-native-chat-find'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import { routeNativeChatRootKeyToInput } from './native-chat-root-key-routing'
import type { NativeChatComposerHandle } from './NativeChatComposer'

const mocks = vi.hoisted(() => {
  const bindings: { current?: KeybindingOverrides } = {}
  return { bindings }
})
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ keybindings: mocks.bindings.current }) }
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

type Composer = NativeChatComposerHandle & { element: HTMLTextAreaElement }

function composerHandle(): Composer {
  const element = document.createElement('textarea')
  return {
    element,
    focus: vi.fn(() => {
      if (!element.isConnected) {
        return false
      }
      element.focus()
      return true
    }),
    insertTypedText: vi.fn(() => true),
    appendText: vi.fn(),
    acceptsText: () => true,
    handlePasteEvent: vi.fn(),
    pasteFromClipboard: vi.fn(),
    contains: (node) => element.contains(node)
  }
}

type ChatProps = {
  composer: Composer
  transcript: ReactNode
  enabled?: boolean
  reveal?: (match: Range) => void
  onComposerEscape?: () => void
}

function Chat({
  composer,
  transcript,
  enabled = true,
  reveal = vi.fn(),
  onComposerEscape
}: ChatProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle | null>(composer)
  const messageListRef = useRef({ revealFindMatch: reveal })
  const find = useNativeChatFind(enabled, rootRef, composerRef, messageListRef)
  useNativeChatPasteBridge({ rootRef, composerRef })
  return (
    <div ref={rootRef} data-native-chat-root="true" tabIndex={-1}>
      <div className="relative">
        {find.isOpen ? <NativeChatFindBar find={find} isVisible /> : null}
        <div data-native-chat-scroll>
          <div data-native-chat-transcript-column>{transcript}</div>
        </div>
      </div>
      <div
        ref={(node) => {
          if (node && !node.contains(composer.element)) {
            node.append(composer.element)
            composer.element.addEventListener('keydown', (event) => {
              // Mirrors the composer: an Escape nothing claimed interrupts the turn.
              if (event.key === 'Escape' && !event.defaultPrevented) {
                onComposerEscape?.()
              }
            })
          }
        }}
      />
    </div>
  )
}

function pressModF(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'f',
    code: 'KeyF',
    bubbles: true,
    cancelable: true,
    metaKey: isMacPlatform(),
    ctrlKey: !isMacPlatform(),
    ...init
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

/** The focused find input when two chats have one open, else the only one. */
function findInput(): HTMLInputElement | null {
  const inputs = screen
    .queryAllByRole('textbox', { name: 'Find in chat' })
    .filter((element) => element instanceof HTMLInputElement)
  return inputs.find((input) => input === document.activeElement) ?? inputs[0] ?? null
}

function typeQuery(value: string): void {
  const input = findInput()
  if (!input) {
    throw new Error('find bar is not open')
  }
  fireEvent.change(input, { target: { value } })
}

function status(): string | null | undefined {
  return findInput()?.parentElement?.querySelector('[aria-live]')?.textContent
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

const TRANSCRIPT = (
  <>
    <p>alpha one</p>
    <p>
      two <strong>alpha</strong>
    </p>
    <span className="sr-only">alpha label</span>
    <div hidden>alpha collapsed</div>
    <span style={{ display: 'none' }}>alpha undisplayed</span>
    <span style={{ opacity: 0 }}>alpha hover-only control</span>
  </>
)

beforeEach(() => {
  delete mocks.bindings.current
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('native chat find', () => {
  it('opens from the composer and counts only what the transcript shows', () => {
    const composer = composerHandle()
    composer.element.value = 'alpha in the draft'
    render(<Chat composer={composer} transcript={TRANSCRIPT} />)
    composer.element.focus()

    expect(pressModF(composer.element).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(findInput())

    typeQuery('ALPHA')
    expect(status()).toBe('1/2')
    typeQuery('nothing here')
    expect(status()).toBe('No results')
  })

  it('leaves Mod+F alone outside the chat and while the chat is not focused', () => {
    const composer = composerHandle()
    const outside = document.createElement('input')
    document.body.append(outside)
    const view = render(<Chat composer={composer} transcript={TRANSCRIPT} />)
    expect(pressModF(outside).defaultPrevented).toBe(false)

    view.rerender(<Chat composer={composer} transcript={TRANSCRIPT} enabled={false} />)
    expect(pressModF(composer.element).defaultPrevented).toBe(false)
    expect(findInput()).toBeNull()
  })

  it('steps with Enter and Shift+Enter, revealing each match through the transcript', () => {
    const reveal = vi.fn()
    const composer = composerHandle()
    render(<Chat composer={composer} transcript={TRANSCRIPT} reveal={reveal} />)
    pressModF(composer.element)
    typeQuery('alpha')
    reveal.mockClear()

    press(findInput()!, 'Enter')
    expect(status()).toBe('2/2')
    expect(reveal).toHaveBeenLastCalledWith(expect.any(Range))
    expect(reveal.mock.lastCall?.[0].toString()).toBe('alpha')
    press(findInput()!, 'Enter', { shiftKey: true })
    expect(status()).toBe('1/2')
    press(findInput()!, 'Enter', { shiftKey: true })
    expect(status()).toBe('2/2')
    expect(reveal).toHaveBeenCalledTimes(3)
  })

  it('refocuses on Mod+F without moving the match, and keeps the query on reopen', () => {
    const composer = composerHandle()
    render(<Chat composer={composer} transcript={TRANSCRIPT} />)
    pressModF(composer.element)
    typeQuery('alpha')
    press(findInput()!, 'Enter')
    composer.element.focus()

    expect(pressModF(composer.element).defaultPrevented).toBe(true)
    const input = findInput()!
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5])
    expect(status()).toBe('2/2')

    press(input, 'Escape')
    expect(findInput()).toBeNull()
    pressModF(composer.element)
    expect(findInput()?.value).toBe('alpha')
  })

  it('Escape in the bar closes it and returns focus to where find was opened from', () => {
    const composer = composerHandle()
    render(
      <Chat
        composer={composer}
        transcript={
          <button type="button" data-testid="row-action">
            alpha
          </button>
        }
      />
    )
    const rowAction = screen.getByTestId('row-action')
    rowAction.focus()
    pressModF(rowAction)
    expect(press(findInput()!, 'Escape').defaultPrevented).toBe(true)
    expect(findInput()).toBeNull()
    expect(document.activeElement).toBe(rowAction)
  })

  it('falls back to the composer when the element find was opened from is gone', () => {
    const composer = composerHandle()
    const view = render(
      <Chat composer={composer} transcript={<button type="button">alpha</button>} />
    )
    screen.getByRole('button', { name: 'alpha' }).focus()
    pressModF(screen.getByRole('button', { name: 'alpha' }))
    view.rerender(<Chat composer={composer} transcript={<p>alpha</p>} />)
    press(findInput()!, 'Escape')
    expect(document.activeElement).toBe(composer.element)
  })

  it('Escape elsewhere in the chat closes the bar first; the next Escape reaches the composer', () => {
    const onComposerEscape = vi.fn()
    const composer = composerHandle()
    render(<Chat composer={composer} transcript={TRANSCRIPT} onComposerEscape={onComposerEscape} />)
    pressModF(composer.element)
    composer.element.focus()

    expect(press(composer.element, 'Escape').defaultPrevented).toBe(true)
    expect(findInput()).toBeNull()
    expect(onComposerEscape).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(composer.element)

    press(composer.element, 'Escape')
    expect(onComposerEscape).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to an open suggestion list or a layer that already used it', () => {
    const composer = composerHandle()
    render(<Chat composer={composer} transcript={TRANSCRIPT} />)
    pressModF(composer.element)
    composer.element.setAttribute('aria-expanded', 'true')
    expect(press(composer.element, 'Escape').defaultPrevented).toBe(false)
    expect(findInput()).not.toBeNull()

    composer.element.setAttribute('aria-expanded', 'false')
    const claimed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    claimed.preventDefault()
    act(() => {
      composer.element.dispatchEvent(claimed)
    })
    expect(findInput()).not.toBeNull()
  })

  it('re-searches when the transcript changes, keeping the active match', async () => {
    function Streaming({ composer }: { composer: Composer }): React.JSX.Element {
      const [rows, setRows] = useState(['alpha one', 'alpha two'])
      return (
        <>
          <button type="button" onClick={() => setRows((r) => [...r, 'alpha three'])}>
            append
          </button>
          <button type="button" onClick={() => setRows((r) => ['alpha zero', ...r])}>
            prepend
          </button>
          <Chat
            composer={composer}
            transcript={rows.map((row) => (
              <p key={row}>{row}</p>
            ))}
          />
        </>
      )
    }
    const composer = composerHandle()
    render(<Streaming composer={composer} />)
    pressModF(composer.element)
    typeQuery('alpha')
    press(findInput()!, 'Enter')
    expect(status()).toBe('2/2')

    fireEvent.click(screen.getByRole('button', { name: 'append' }))
    await nextFrame()
    expect(status()).toBe('2/3')

    fireEvent.click(screen.getByRole('button', { name: 'prepend' }))
    await nextFrame()
    expect(status()).toBe('3/4')
  })

  it('paints into a shared registry as a union with another open find, and clears on close', () => {
    class StubHighlight {
      readonly ranges = new Set<Range>()
      add(range: Range): void {
        this.ranges.add(range)
      }
    }
    const registry = new Map<string, StubHighlight>()
    vi.stubGlobal('Highlight', StubHighlight)
    vi.stubGlobal('CSS', { highlights: registry })
    const first = composerHandle()
    const second = composerHandle()
    render(
      <>
        <Chat composer={first} transcript={<p>alpha alpha</p>} />
        <Chat composer={second} transcript={<p>alpha</p>} />
      </>
    )
    pressModF(first.element)
    typeQuery('alpha')
    pressModF(second.element)
    typeQuery('alpha')
    expect(registry.get('native-chat-find-match')?.ranges.size).toBe(3)
    expect(registry.get('native-chat-find-active-match')?.ranges.size).toBe(2)

    press(findInput()!, 'Escape')
    expect(registry.get('native-chat-find-match')?.ranges.size).toBe(2)
    press(findInput()!, 'Escape')
    expect(registry.has('native-chat-find-match')).toBe(false)
    expect(registry.has('native-chat-find-active-match')).toBe(false)
  })

  it('keeps paste, typing and editing keys in the find input', () => {
    const composer = composerHandle()
    render(<Chat composer={composer} transcript={TRANSCRIPT} />)
    pressModF(composer.element)
    const input = findInput()!

    // Unclaimed by the chat, the app-menu paste goes to the focused text control: the find input.
    expect(dispatchAppMenuPasteEvent()).toBe(false)
    expect(composer.pasteFromClipboard).not.toHaveBeenCalled()
    expect(findOwnedTextControlPasteTarget(document.activeElement)).toBe(input)

    for (const key of ['a', 'Backspace', 'v']) {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        metaKey: key === 'v' && isMacPlatform(),
        ctrlKey: key === 'v' && !isMacPlatform()
      })
      Object.defineProperty(event, 'target', { value: input })
      routeNativeChatRootKeyToInput(event, composer, null)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(composer.insertTypedText).not.toHaveBeenCalled()
    expect(composer.focus).not.toHaveBeenCalled()
  })
})
