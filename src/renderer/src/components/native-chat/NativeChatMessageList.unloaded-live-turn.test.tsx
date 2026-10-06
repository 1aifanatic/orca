// @vitest-environment happy-dom

// A long turn's record and opening message sit above the loaded page. The host's newest turn record
// still names the turn, so its loaded rows draw under the live Working bar.

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionLatestTurn } from '../../../../shared/agent-session-wire'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const TURN_RECORD = 'turn-record-1'
const IN_TURN: AgentJournalTurnScope = { kind: 'turn', turnItemId: TURN_RECORD }

/** The newest rows of the turn: everything from its 300th row on. */
const loaded: AgentJournalRenderItem[] = [300, 301, 302].map((sequence) => ({
  itemId: `row-${sequence}`,
  revision: 0,
  sequence,
  observedAt: sequence,
  body: {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: `Step ${sequence}` }]
  },
  turnScope: IN_TURN
}))

function list(latestTurn: AgentSessionLatestTurn | null | undefined): React.JSX.Element {
  return (
    <NativeChatMessageList
      session={{
        messages: projectStructuredAgentSessionMessages(loaded, [], [], { rejectedInPlace: true }),
        status: 'ready',
        sessionId: 'session-1',
        agent: 'codex',
        hasMore: true,
        loadingEarlier: false,
        olderHistoryGeneration: 0,
        loadEarlier: vi.fn(),
        readPhase: 'ready'
      }}
      journalItems={loaded}
      journalSubmissions={[]}
      journalLatestTurn={latestTurn}
      isWorking
      workingStartedAt={1_000}
      expandSignal={false}
      fontScale={1}
    />
  )
}

describe('a live turn whose record and opening message are not loaded', () => {
  it('draws its Working bar with the running clock', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(64_000)
    try {
      render(
        list({
          itemId: TURN_RECORD,
          observedAt: 1,
          turn: { turnId: 'turn-1', state: 'running', startedAt: 1_000, userItemId: 'user-1' }
        })
      )
      expect(screen.getByText('Step 302')).toBeInTheDocument()
      expect(screen.getByText(/Working for 1m 3s/)).toBeInTheDocument()
    } finally {
      now.mockRestore()
    }
  })

  it('had no bar to draw from the loaded rows alone', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(64_000)
    try {
      render(list(undefined))
      expect(screen.getByText('Step 302')).toBeInTheDocument()
      expect(screen.queryByText(/Working for/)).not.toBeInTheDocument()
    } finally {
      now.mockRestore()
    }
  })
})
