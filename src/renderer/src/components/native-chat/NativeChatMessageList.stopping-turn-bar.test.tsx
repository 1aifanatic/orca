// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'

const turnItem: AgentJournalItemBody = { kind: 'turn', turnId: 'turn-1', state: 'running' }

function journalItem(sequence: number, body: AgentJournalItemBody): AgentJournalRenderItem {
  return { itemId: `item-${sequence}`, revision: 1, sequence, observedAt: sequence, body }
}

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const session: NativeChatLiveSession = {
  messages: [
    {
      id: 'user-stop',
      role: 'user',
      blocks: [{ type: 'text', text: 'Start the task' }],
      timestamp: Date.now(),
      source: 'transcript'
    }
  ],
  status: 'working',
  sessionId: 'session-1',
  agent: 'codex',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: vi.fn(),
  readPhase: 'ready'
}

// The turn still runs while a Stop ends it, so its bar keeps the running clock; only the tail line
// says the turn is stopping, and the bar settles to "Interrupted after" once the turn ends.
describe("the turn bar while a person's Stop ends the turn", () => {
  it('keeps the running clock above the Stopping tail line', () => {
    render(
      <NativeChatMessageList
        session={session}
        journalItems={[journalItem(1, turnItem)]}
        isWorking
        stopping
        expandSignal={false}
        fontScale={1}
      />
    )

    const bar = screen.getByText('Working for 0s')
    const stopping = screen.getByText('Stopping…')
    expect(bar.compareDocumentPosition(stopping)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(screen.getAllByText(/Stopping/)).toHaveLength(1)
  })
})
