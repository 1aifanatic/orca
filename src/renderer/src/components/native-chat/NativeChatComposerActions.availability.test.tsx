// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatComposerActions } from './NativeChatComposerActions'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./NativeChatSessionOptionPickers', () => ({ NativeChatSessionOptionPickers: () => null }))
afterEach(cleanup)
const REASON = "This Claude account isn't signed in. Sign in again in Claude Accounts settings."
function actions(working = false) {
  const onSend = vi.fn()
  const onStop = vi.fn()
  render(
    <TooltipProvider delayDuration={0}>
      <NativeChatComposerActions
        attachDisabled={false}
        dictationDisabled={false}
        sendDisabled={!working}
        sendBlockedReason={REASON}
        primaryAction={working ? 'stop' : 'send'}
        isWorking={working}
        isDictating={false}
        isDictationHoldMode={false}
        onAttach={vi.fn()}
        onDictationToggle={vi.fn()}
        onDictationHoldStart={vi.fn()}
        onDictationHoldEnd={vi.fn()}
        onSend={onSend}
        onStop={onStop}
        sessionOptionsSurface={null}
        sessionOptionsSnapshot={[]}
      />
    </TooltipProvider>
  )
  return { onSend, onStop }
}
describe('unavailable Send explanation', () => {
  it('keeps Send disabled and opens the explanation on keyboard focus', async () => {
    const { onSend } = actions()
    const button = screen.getByRole('button', { name: REASON })
    expect(button.hasAttribute('disabled')).toBe(true)
    const trigger = button.parentElement!
    expect(trigger.getAttribute('tabindex')).toBe('0')
    await act(async () => {
      trigger.focus()
    })
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe(REASON))
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(button)
    expect(onSend).not.toHaveBeenCalled()
  })
  it('opens the explanation when hovering the disabled button wrapper', async () => {
    actions()
    const trigger = screen.getByRole('button', { name: REASON }).parentElement!
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' })
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe(REASON))
  })
})
