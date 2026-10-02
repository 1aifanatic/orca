import { expect, it } from 'vitest'
import { nativeChatComposerPlaceholder } from './native-chat-composer-target'

it("says a locked composer's reason when one is given, else that another device holds the input", () => {
  expect(nativeChatComposerPlaceholder(true, false, 'Saved by a newer Orca.')).toBe(
    'Saved by a newer Orca.'
  )
  expect(nativeChatComposerPlaceholder(true, false)).toBe('Input is held by another device.')
  expect(nativeChatComposerPlaceholder(true, true, 'Saved by a newer Orca.')).toBe(
    'Send a message…'
  )
})
