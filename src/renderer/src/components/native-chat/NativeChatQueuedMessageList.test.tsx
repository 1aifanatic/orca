// @vitest-environment happy-dom

// The card stack above the composer: an accessible, labeled live list whose
// rows expose Steer/Send, Delete, and the Edit / Turn-off-queueing menu, with
// captions derived client-side per state.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../../store', () => {
  const state = { updateSettings: mocks.updateSettings }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

import { TooltipProvider } from '@/components/ui/tooltip'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import { queuedMessageCardSendNow } from './NativeChatQueuedMessageCard'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

function renderList(owner: StructuredAgentSessionQueuedMessagesController) {
  // The app root mounts the provider; tests supply the same context.
  return render(
    <TooltipProvider delayDuration={0}>
      <NativeChatQueuedMessageList controller={owner} />
    </TooltipProvider>
  )
}

function card(overrides: Partial<QueuedMessageCard> & { messageId: string }): QueuedMessageCard {
  return {
    position: 1,
    text: `text of ${overrides.messageId}`,
    state: 'waiting',
    hold: 'turn',
    ...overrides
  }
}

function controller(cards: QueuedMessageCard[]): StructuredAgentSessionQueuedMessagesController & {
  steer: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  edit: ReturnType<typeof vi.fn>
} {
  return {
    cards,
    steer: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    steerNewest: vi.fn(() => false)
  }
}

beforeEach(() => {
  mocks.updateSettings.mockReset()
})

afterEach(cleanup)

describe('NativeChatQueuedMessageList', () => {
  it('renders only an empty live region when the host holds no drafts', () => {
    const { container } = renderList(controller([]))
    expect(screen.queryByRole('list')).toBeNull()
    expect(container.querySelector('[aria-live="polite"]')?.childElementCount).toBe(0)
  })

  it('the first card appears inside a live region that was already mounted', () => {
    const { container, rerender } = renderList(controller([]))
    const region = container.querySelector('[aria-live="polite"]')
    rerender(
      <TooltipProvider delayDuration={0}>
        <NativeChatQueuedMessageList controller={controller([card({ messageId: 'draft-1' })])} />
      </TooltipProvider>
    )
    expect(container.querySelector('[aria-live="polite"]')).toBe(region)
    expect(region?.contains(screen.getByRole('list', { name: 'Queued messages' }))).toBe(true)
  })

  it('is a labeled list with one row per draft, in order', () => {
    renderList(
      controller([
        card({ messageId: 'draft-1', position: 1 }),
        card({ messageId: 'draft-2', position: 2 })
      ])
    )
    screen.getByRole('list', { name: 'Queued messages' })
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('text of draft-1')
    expect(rows[1]?.textContent).toContain('text of draft-2')
  })

  it('Steer and Delete are named buttons wired to their card', () => {
    const owner = controller([
      card({ messageId: 'draft-1', position: 1 }),
      card({ messageId: 'draft-2', position: 2 })
    ])
    renderList(owner)
    fireEvent.click(screen.getAllByRole('button', { name: 'Steer' })[0]!)
    expect(owner.steer).toHaveBeenCalledWith('draft-1')
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]!)
    expect(owner.remove).toHaveBeenCalledWith('draft-2')
  })

  it.each(['Delete', 'Steer'])(
    '%s hands focus to the composer once the focused card is gone',
    async (name) => {
      const focusComposer = vi.fn()
      const owner = controller([card({ messageId: 'draft-1', position: 1 })])
      render(
        <TooltipProvider delayDuration={0}>
          <NativeChatQueuedMessageList controller={owner} focusComposer={focusComposer} />
        </TooltipProvider>
      )
      const action = screen.getByRole('button', { name })
      action.focus()
      fireEvent.click(action)
      await waitFor(() => expect(focusComposer).toHaveBeenCalledTimes(1))
    }
  )

  it('a returned card shows the stored reason and offers Send instead of Steer', () => {
    const owner = controller([
      card({
        messageId: 'refused',
        state: 'returned',
        hold: 'returned',
        // Internal marker: never shown verbatim, exactly as for rejected submissions.
        returnedReason: 'host_restarted_before_delivery'
      })
    ])
    renderList(owner)
    expect(screen.getByRole('listitem').textContent).toContain('Your message was not sent.')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(owner.steer).toHaveBeenCalledWith('refused')
    expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull()
  })

  it("a provider's own refusal words are shown verbatim", () => {
    renderList(
      controller([
        card({
          messageId: 'refused',
          state: 'returned',
          hold: 'returned',
          returnedReason: 'The active turn cannot be steered during review.'
        })
      ])
    )
    expect(screen.getByRole('listitem').textContent).toContain(
      'The active turn cannot be steered during review.'
    )
  })

  it("a Stop's paused card says the queue resumes with the next message and offers Send", () => {
    renderList(controller([card({ messageId: 'held', hold: 'paused', pausedReason: 'stopped' })]))
    expect(screen.getByRole('listitem').textContent).toContain(
      'Paused — sends after your next message'
    )
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })

  it('only a card still waiting on the turn promises to skip the wait', () => {
    for (const hold of ['turn', 'awaiting-answer', 'behind-returned'] as const) {
      expect(queuedMessageCardSendNow(card({ messageId: hold, hold }))).toEqual({
        label: 'Steer',
        hint: 'Send now without waiting for the turn to end'
      })
    }
    for (const hold of ['paused', 'returned'] as const) {
      expect(queuedMessageCardSendNow(card({ messageId: hold, hold }))).toEqual({
        label: 'Send',
        hint: 'Send this message now'
      })
    }
  })

  it("the host's pause and withdrawal markers localize instead of rendering raw", () => {
    renderList(
      controller([
        card({
          messageId: 'failed-consume',
          hold: 'paused',
          pausedReason: 'send_failed'
        }),
        card({
          messageId: 'stopped',
          state: 'returned',
          hold: 'returned',
          position: 2,
          // A cancellation confirmed after Stop settled renders as an ordinary card.
          returnedReason: 'provider_cancelled_before_start'
        })
      ])
    )
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain("Couldn't send — press Send to retry.")
    expect(rows[0]?.textContent).not.toContain('send_failed')
    expect(rows[1]?.textContent).toContain('Stopped before it was sent')
    // Still a normal returned card: Send and Delete stay offered.
    expect(screen.getAllByRole('button', { name: 'Send' }).length).toBeGreaterThan(0)
  })

  it('an absent or unknown pause marker reads as a plain pause, never raw', () => {
    renderList(
      controller([
        card({ messageId: 'future', hold: 'paused', pausedReason: 'some_newer_marker' }),
        card({ messageId: 'bare', hold: 'paused', position: 2 })
      ])
    )
    for (const row of screen.getAllByRole('listitem')) {
      expect(row.querySelectorAll('p')[1]?.textContent).toBe('Paused')
    }
    expect(screen.getAllByRole('listitem')[0]?.textContent).not.toContain('some_newer_marker')
  })

  it('a draft behind a returned card says a message ahead needs attention', () => {
    renderList(controller([card({ messageId: 'behind', hold: 'behind-returned' })]))
    expect(screen.getByRole('listitem').textContent).toContain(
      'Waiting — a message ahead needs attention'
    )
  })

  it('the menu offers Edit message and Turn off queueing', async () => {
    const owner = controller([card({ messageId: 'draft-1' })])
    renderList(owner)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
    expect(owner.edit).toHaveBeenCalledWith('draft-1')
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Turn off queueing' }))
    expect(mocks.updateSettings).toHaveBeenCalledWith({ nativeChatQueueFollowUps: false })
  })
})
