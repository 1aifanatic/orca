// @vitest-environment happy-dom
// The composer's placeholder as the real editor draws it: a lock with a reason shows the reason,
// and every other state draws what it drew before.

import { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  NativeChatComposerField,
  type NativeChatComposerFieldProps
} from './NativeChatComposerField'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./NativeChatComposerActions', () => ({ NativeChatComposerActions: () => null }))
vi.mock('./NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))

afterEach(cleanup)

const REASON = 'Saved by a newer Orca. Update Orca to continue this chat.'

type State = Pick<NativeChatComposerFieldProps, 'disabled' | 'hasPty' | 'canSend' | 'lockReason'>

function Field(state: State): React.JSX.Element {
  const imeEnterGesture = useImeEnterGestureOwnership()
  return (
    <NativeChatComposerField
      {...state}
      composerScopeKey="pane-1"
      textareaRef={createRef<NativeChatComposerInput>()}
      draft=""
      autocomplete={{ mode: 'none' }}
      activeSuggestion={0}
      notice={null}
      imageAttachments={[]}
      sendButtonDisabled
      isWorking={false}
      attachDisabled={state.disabled}
      dictationDisabled
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
      onSend={vi.fn()}
      sessionOptionsSurface={null}
      sessionOptionsSnapshot={[]}
    />
  )
}

/** What the empty line draws: the editor's `::before` reads this attribute. */
function drawnPlaceholder(): string {
  return document.querySelector('p.is-editor-empty')?.getAttribute('data-placeholder') ?? ''
}

const WRITABLE: State = { disabled: false, hasPty: true, canSend: true }
const LOCKED: State = { disabled: true, hasPty: true, canSend: false, lockReason: REASON }

it('draws the lock reason while the composer is locked, and the usual words once it unlocks', () => {
  const { rerender } = render(<Field {...LOCKED} />)
  expect(drawnPlaceholder()).toBe(REASON)
  rerender(<Field {...WRITABLE} />)
  expect(drawnPlaceholder()).toBe('Send a message…')
  rerender(<Field {...LOCKED} />)
  expect(drawnPlaceholder()).toBe(REASON)
})

it('draws nothing in a composer disabled for any other reason, as before', () => {
  render(<Field disabled hasPty={false} canSend />)
  expect(drawnPlaceholder()).toBe('')
  cleanup()
  render(<Field disabled hasPty canSend={false} />)
  expect(drawnPlaceholder()).toBe('')
})
