// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatReasoningRow } from './NativeChatReasoningRow'
import { MessageRow } from './NativeChatMessageRow'

vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const STARTED = 100_000

describe('reasoning disclosure', () => {
  it('starts collapsed without mounting markdown', () => {
    render(
      <NativeChatReasoningRow
        message={{ timestamp: STARTED, state: 'completed' }}
        markdown={'\n\nInspecting the request\nFull reasoning'}
      />
    )
    expect(screen.getByRole('button', { name: 'Reasoning: Thought' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
  })

  it('expands through a native button and keeps disclosure state through revisions', () => {
    const message = { timestamp: STARTED, state: 'running' as const }
    const { rerender } = render(
      <NativeChatReasoningRow message={message} markdown="Inspecting" turnIsWorking />
    )
    const trigger = screen.getByRole('button')
    expect(trigger.tagName).toBe('BUTTON')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('markdown')).toHaveTextContent('Inspecting')
    rerender(
      <NativeChatReasoningRow message={message} markdown={'Inspecting\nMore'} turnIsWorking />
    )
    expect(screen.getByRole('button')).toBe(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('markdown')).toHaveTextContent('More')
    // Collapsed again by the user, it stays collapsed through the next streamed revision.
    fireEvent.click(trigger)
    rerender(
      <NativeChatReasoningRow message={message} markdown={'Inspecting\nFinal'} turnIsWorking />
    )
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
  })

  it.each(['', ' \n\t'])('draws nothing for blank reasoning %j', (markdown) => {
    const { container } = render(
      <NativeChatReasoningRow
        message={{ timestamp: STARTED, state: 'running' }}
        markdown={markdown}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the reasoning headline', () => {
  const headline = (
    message: Pick<NativeChatMessage, 'state' | 'completedAt' | 'timestamp'>,
    turnIsWorking = false
  ) => {
    render(
      <NativeChatReasoningRow message={message} markdown="Reasoned" turnIsWorking={turnIsWorking} />
    )
    return screen.getByRole('button').textContent
  }

  it('reads Thinking only while the row is open and its turn is running', () => {
    expect(headline({ timestamp: STARTED, state: 'running' }, true)).toContain('Thinking…')
    expect(screen.getByText('Thinking…')).toHaveClass('animate-pulse')
  })

  it('does not read Thinking for a closed row while the turn goes on working', () => {
    expect(
      headline({ timestamp: STARTED, state: 'completed', completedAt: STARTED + 12_000 }, true)
    ).toContain('Thought for 12s')
  })

  it('measures the span the host saw, at least one second', () => {
    expect(
      headline({ timestamp: STARTED, state: 'completed', completedAt: STARTED + 65_000 })
    ).toContain('Thought for 1m 5s')
    cleanup()
    expect(
      headline({ timestamp: STARTED, state: 'completed', completedAt: STARTED + 300 })
    ).toContain('Thought for 1s')
  })

  it('claims no duration it never saw, and nothing live for an open row in a settled turn', () => {
    expect(headline({ timestamp: STARTED, state: 'completed' })).toBe('Reasoning: Thought')
    cleanup()
    expect(headline({ timestamp: STARTED, state: 'running' })).toBe('Reasoning: Thought')
  })

  it('stays neutral for a row from a host that kept no lifecycle', () => {
    expect(headline({ timestamp: STARTED }, true)).toBe('Reasoning')
  })

  it('reads the lifecycle through the message row', () => {
    const message: NativeChatMessage = {
      id: 'reasoning-1',
      role: 'reasoning',
      source: 'transcript',
      timestamp: STARTED,
      state: 'running',
      blocks: [{ type: 'text', text: 'Inspecting the request\nFull reasoning' }]
    }
    const { rerender } = render(
      <MessageRow
        message={message}
        activeTurnIsWorking
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    )
    expect(screen.getByRole('button')).toHaveTextContent('Thinking…')
    rerender(
      <MessageRow
        message={{ ...message, state: 'completed', completedAt: STARTED + 3_000 }}
        activeTurnIsWorking
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    )
    expect(screen.getByRole('button')).toHaveTextContent('Thought for 3s')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('markdown')).toHaveTextContent('Full reasoning')
  })
})
