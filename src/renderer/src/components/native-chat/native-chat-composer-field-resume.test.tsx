// @vitest-environment happy-dom

// A held queue's Resume is the composer's primary button exactly while nothing is typed or
// attached, no turn runs, and the queue controller offers it; Send otherwise, Stop while running.

import { useRef, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children: ReactNode
    variant?: string
    size?: string
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('./NativeChatSessionOptionPickers', () => ({
  NativeChatSessionOptionPickers: () => null
}))

vi.mock('./NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))

vi.mock('@/components/editor/useLocalImageSrc', () => ({
  useLocalImageSrc: () => undefined
}))

import { NativeChatComposerField } from './NativeChatComposerField'
import type { NativeChatQueuePrimary } from './native-chat-composer-primary-action'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'

afterEach(() => cleanup())

type FieldInput = {
  /** The composer cannot send at all. */
  disabled?: boolean
  draft?: string
  imageAttachments?: { id: string; path: string }[]
  isWorking?: boolean
  queuePrimary?: NativeChatQueuePrimary
}

const NO_IMAGES: { id: string; path: string }[] = []

function TestField({
  disabled = false,
  draft = '',
  imageAttachments = NO_IMAGES,
  isWorking = false,
  queuePrimary,
  onSend
}: FieldInput & { onSend: () => void }): React.JSX.Element {
  const imeEnterGesture = useImeEnterGestureOwnership()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  return (
    <NativeChatComposerField
      composerScopeKey="pane-test"
      textareaRef={textareaRef}
      draft={draft}
      disabled={disabled}
      hasPty
      canSend
      autocomplete={{ mode: 'none' }}
      activeSuggestion={0}
      notice={null}
      imageAttachments={imageAttachments}
      sendButtonDisabled={disabled || (!isWorking && draft === '' && imageAttachments.length === 0)}
      isWorking={isWorking}
      attachDisabled={false}
      dictationDisabled={false}
      isDictating={false}
      isDictationHoldMode={false}
      imeEnterGesture={imeEnterGesture}
      onDraftChange={vi.fn()}
      onTextareaSelect={vi.fn()}
      onKeyDown={vi.fn()}
      onImeSettled={vi.fn()}
      onPaste={vi.fn()}
      pickerListboxId="picker"
      onChoosePickerItem={vi.fn()}
      onRetrySkills={vi.fn()}
      onAcceptMention={vi.fn()}
      onRemoveImageAttachment={vi.fn()}
      onAttach={vi.fn()}
      onDictationToggle={vi.fn()}
      onDictationHoldStart={vi.fn()}
      onDictationHoldEnd={vi.fn()}
      onSend={onSend}
      onStop={vi.fn()}
      queuePrimary={queuePrimary}
      sessionOptionsSurface={null}
      sessionOptionsSnapshot={[]}
    />
  )
}

/** The primary button's accessible name: the last button in the actions row. */
function primaryButton(input: FieldInput, onSend = vi.fn()): HTMLButtonElement {
  render(<TestField {...input} onSend={onSend} />)
  const buttons = screen.getAllByRole('button')
  const last = buttons.at(-1)
  if (!(last instanceof HTMLButtonElement)) {
    throw new Error('expected the primary button')
  }
  return last
}

describe('the composer primary button over a held queue', () => {
  const held = () => ({ kind: 'resume' as const, resume: vi.fn(), resuming: false })

  it('is Resume on an empty composer with no turn running; one press resumes, never sends', () => {
    const queuePrimary = held()
    const onSend = vi.fn()
    const button = primaryButton({ queuePrimary }, onSend)
    expect(button.getAttribute('aria-label')).toBe('Resume')
    expect(button.disabled).toBe(false)
    fireEvent.click(button, { detail: 1 })
    expect(queuePrimary.resume).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
  })

  it.each([
    ['text is typed', { draft: 'hello' }, 'Send'],
    ['an image is attached', { imageAttachments: [{ id: 'image-1', path: '/tmp/a.png' }] }, 'Send'],
    ['a turn runs', { isWorking: true }, 'Stop the agent']
  ])('gives way when %s', (_case, input, label) => {
    expect(primaryButton({ ...input, queuePrimary: held() }).getAttribute('aria-label')).toBe(label)
  })

  it('is a disabled Stop while the queue is about to send a card, never Send; typing gives Send', () => {
    const sending = primaryButton({ queuePrimary: { kind: 'sending' } })
    expect(sending.getAttribute('aria-label')).toBe('Stop the agent')
    expect(sending.disabled).toBe(true)
    cleanup()
    const typed = primaryButton({ draft: 'hello', queuePrimary: { kind: 'sending' } })
    expect(typed.getAttribute('aria-label')).toBe('Send')
  })

  it('puts focus back in the composer after Resume', () => {
    const button = primaryButton({ queuePrimary: held() })
    button.focus()
    fireEvent.click(button, { detail: 1 })
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })

  it('is disabled whenever Send would be: the composer cannot send', () => {
    expect(primaryButton({ draft: 'hello', disabled: true }).disabled).toBe(true)
    cleanup()
    const resume = primaryButton({ disabled: true, queuePrimary: held() })
    expect(resume.getAttribute('aria-label')).toBe('Resume')
    expect(resume.disabled).toBe(true)
  })

  it('is Send when nothing is held, and disabled while a Resume is in flight', () => {
    expect(primaryButton({}).getAttribute('aria-label')).toBe('Send')
    cleanup()
    const resuming = primaryButton({
      queuePrimary: { kind: 'resume', resume: vi.fn(), resuming: true }
    })
    expect(resuming.getAttribute('aria-label')).toBe('Resume')
    expect(resuming.disabled).toBe(true)
  })
})
