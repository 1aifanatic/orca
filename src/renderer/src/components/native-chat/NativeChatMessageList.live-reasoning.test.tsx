// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const STARTED = 1_000

const prompt: NativeChatMessage = {
  id: 'user-1',
  role: 'user',
  blocks: [{ type: 'text', text: 'Start the task' }],
  timestamp: STARTED - 500,
  source: 'transcript'
}

function reasoning(
  id: string,
  text: string,
  state: 'running' | 'completed',
  fields: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role: 'reasoning',
    blocks: [{ type: 'text', text }],
    timestamp: STARTED,
    source: 'transcript',
    state,
    ...(state === 'completed' ? { completedAt: STARTED + 12_000 } : {}),
    ...fields
  }
}

/** The journal that says the turn runs and what its newest content is. */
function journal(rows: readonly NativeChatMessage[]): AgentJournalRenderItem[] {
  return [
    {
      itemId: prompt.id,
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: prompt.blocks }
    },
    {
      itemId: 'turn-1',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: { kind: 'turn', turnId: 'turn-1', state: 'running', userItemId: prompt.id }
    },
    ...rows.map((row, index) => ({
      itemId: row.id,
      revision: 1,
      sequence: index + 3,
      observedAt: index + 3,
      ...(row.agentId ? { agentId: row.agentId } : {}),
      body: {
        kind: 'message' as const,
        role: row.role,
        blocks: row.blocks,
        ...(row.state ? { state: row.state } : {})
      }
    }))
  ]
}

function list(
  rows: readonly NativeChatMessage[],
  props: Partial<React.ComponentProps<typeof NativeChatMessageList>> = {}
): React.JSX.Element {
  const session: NativeChatLiveSession = {
    messages: [prompt, ...rows],
    status: 'working',
    sessionId: 'session-1',
    agent: 'claude',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
  return (
    <NativeChatMessageList
      session={session}
      journalItems={journal(rows)}
      isWorking
      expandSignal={false}
      fontScale={1}
      {...props}
    />
  )
}

const liveLine = (): HTMLElement =>
  screen.getByText('Thinking').closest<HTMLElement>('[data-native-chat-turn-activity]')!

describe('live reasoning, read through the one live line', () => {
  it('shows one "Thinking", collapsed, and no row for the open block', () => {
    render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
    expect(screen.getAllByText('Thinking')).toHaveLength(1)
    const toggle = screen.getByRole('button', { name: 'Thinking' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(liveLine()).toContainElement(toggle)
    expect(screen.queryByRole('button', { name: /Reasoning|Thought/ })).toBeNull()
    expect(screen.queryByText('Weighing two approaches')).toBeNull()
  })

  it('opens to the live text, which follows the block as it grows', () => {
    const { rerender } = render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByText('Weighing two approaches')).toBeInTheDocument()
    rerender(list([reasoning('r-1', 'Weighing two approaches, then the cheaper one', 'running')]))
    expect(screen.getByText('Weighing two approaches, then the cheaper one')).toBeInTheDocument()
  })

  it('keeps the body out of the live region, which announces the label only', () => {
    render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    const body = screen.getByText('Weighing two approaches')
    expect(body.closest('[aria-live]')).toBeNull()
    expect(screen.getByText('Thinking').closest('[aria-live]')).not.toBeNull()
  })

  it('lands the finished row open when the reader opened it live, while the turn works on', () => {
    const { rerender } = render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    rerender(list([reasoning('r-1', 'Weighing two approaches', 'completed')]))
    // The line no longer discloses anything; the row does, still open.
    expect(screen.queryByRole('button', { name: /Thinking|Working/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reasoning: Thought for 12s' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByText('Weighing two approaches')).toBeInTheDocument()
  })

  it('starts the next block collapsed', () => {
    const { rerender } = render(list([reasoning('r-1', 'First thought', 'running')]))
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    rerender(
      list([reasoning('r-1', 'First thought', 'completed'), reasoning('r-2', 'Second', 'running')])
    )
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByText('Second')).toBeNull()
  })

  it('is not expandable while the open block has no text yet', () => {
    render(list([reasoning('r-1', '', 'running')]))
    expect(screen.getAllByText('Thinking')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Thinking' })).toBeNull()
  })

  it('draws the open row when a waiting prompt replaces the line', () => {
    render(
      list([reasoning('r-1', 'Weighing two approaches', 'running')], {
        awaitingInput: 'unshown'
      })
    )
    expect(screen.queryByText('Thinking')).toBeNull()
    expect(screen.getByRole('button', { name: 'Reasoning' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })
})
