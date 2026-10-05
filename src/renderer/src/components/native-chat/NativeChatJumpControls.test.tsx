// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatJumpControls } from './NativeChatJumpControls'

afterEach(cleanup)

// The reader is usually mid-draft when they reach for this: a press must not take the caret.
it('leaves focus in the composer when "Jump to latest" is pressed with the pointer', async () => {
  const onLatest = vi.fn()
  render(
    <>
      <NativeChatJumpControls
        showLatest
        onLatest={onLatest}
        transcriptRef={createRef<HTMLElement>()}
      />
      <textarea aria-label="Message" />
    </>
  )
  const composer = screen.getByRole('textbox', { name: 'Message' })
  composer.focus()

  await userEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))

  // Anti-vacuous: the press did act.
  expect(onLatest).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(composer)
})
