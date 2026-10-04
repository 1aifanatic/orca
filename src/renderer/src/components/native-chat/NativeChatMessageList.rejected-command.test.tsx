// @vitest-environment happy-dom

// A /compact the host recorded and then rejected stays in the chat as not sent, for every viewer,
// and its failure is said once: by its row's line, or, where a host row already says why, by that
// row alone. The host moves a rejected message to its rejection, in no turn, while a command turn
// that opened keeps naming it as its opener.

import '@testing-library/jest-dom/vitest'

import { cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  structuredAgentSessionCommandResultRowIdentity,
  structuredAgentSessionCommandResultRows
} from '../../../../shared/structured-agent-session-command-entry'
import { structuredAgentSessionStartFailureFacts } from '../../../../shared/structured-agent-session-recorded-rejection-words'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const SEED = agentJournalSubmissionKey('seed')
const COMPACT = agentJournalSubmissionKey('compact')
const TURN = agentJournalItemKey({ provider: 'orca', clientMessageId: 'command-turn:compact' })
const BUSY = { text: 'thread busy', audience: 'person' as const }
const START_FAILED: AgentSessionFailureFact = { kind: 'providerStartFailed' }

function row(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body'],
  turnScope: AgentJournalRenderItem['turnScope'] = { kind: 'thread' }
): AgentJournalRenderItem {
  return { itemId, revision: 1, sequence, observedAt: 1000 + sequence, body, turnScope }
}

function hostRow(itemId: string, sequence: number, fact: AgentSessionFailureFact, turn = false) {
  return row(
    itemId,
    sequence,
    {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords(fact, { agentName: 'Codex', surface: 'row' })
    },
    turn ? { kind: 'turn', turnItemId: TURN } : { kind: 'thread' }
  )
}

function submission(
  id: string,
  dispatchState: AgentJournalSubmission['dispatchState'],
  rejection?: AgentSessionFailureFact
): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: id,
    dispatchState,
    providerItemId: null,
    reason: null,
    ...(rejection ? { rejection } : {}),
    submittedAt: 1,
    resolvedAt: 1
  }
}

type Case = 'blocked' | 'refused' | 'startFailed'

function journal(kind: Case): {
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
} {
  const rejection: AgentSessionFailureFact =
    kind === 'blocked'
      ? { kind: 'commandRefused' }
      : kind === 'refused'
        ? { kind: 'providerRejected', detail: BUSY }
        : START_FAILED
  const compact = row(COMPACT, 5, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: '/compact' }],
    command: { name: 'compact' }
  })
  const items: AgentJournalRenderItem[] = [
    row(SEED, 1, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'SEED' }] }),
    row(
      'seed-answer',
      2,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'SEED OK' }] },
      { kind: 'thread' }
    )
  ]
  if (kind === 'refused') {
    // The turn the command opened, its rejection (which moved the message there) and its result.
    items.push(
      row(TURN, 3, {
        kind: 'turn',
        turnId: 'compact:compact',
        state: 'completed',
        outcome: 'failure',
        userItemId: COMPACT
      }),
      compact,
      hostRow(
        agentJournalItemKey(structuredAgentSessionCommandResultRowIdentity('compact')),
        6,
        { kind: 'compactionFailed', detail: BUSY },
        true
      )
    )
  } else if (kind === 'startFailed') {
    items.push(
      compact,
      hostRow(
        agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('g')),
        6,
        START_FAILED
      )
    )
  } else {
    items.push(compact)
  }
  return {
    items,
    submissions: [submission('seed', 'accepted'), submission('compact', 'rejected', rejection)]
  }
}

function list(kind: Case) {
  const { items, submissions } = journal(kind)
  return (
    <NativeChatMessageList
      session={{
        messages: projectStructuredAgentSessionMessages(items, [], submissions, []),
        status: 'ready',
        sessionId: 'session-1',
        agent: 'codex',
        hasMore: false,
        loadingEarlier: false,
        olderHistoryGeneration: 0,
        loadEarlier: vi.fn(),
        readPhase: 'ready'
      }}
      journalItems={items}
      journalSubmissions={submissions}
      deliveryNotices={structuredAgentSessionDeliveryNotices(
        [],
        'Codex',
        vi.fn(),
        submissions,
        structuredAgentSessionStartFailureFacts(items),
        new Set(),
        [],
        structuredAgentSessionCommandResultRows(items)
      )}
      isWorking={false}
      workingStartedAt={null}
      settledTurns={new Map()}
      expandSignal={false}
      fontScale={1}
    />
  )
}

function count(container: HTMLElement, text: string): number {
  return (container.textContent ?? '').split(text).length - 1
}

describe('a /compact the host recorded and then rejected, on the desktop', () => {
  it('shows a blocked one with its own line, the only place it is said', () => {
    const { container } = render(list('blocked'))
    expect(container).toHaveTextContent('/compact')
    expect(count(container, "This command didn't run.")).toBe(1)
    expect(container.querySelector('button[aria-label="Retry"]')).toBeNull()
  })

  it("leaves why to a refused one's result row: its own line says only that it was not sent", () => {
    const { container } = render(list('refused'))
    const text = container.textContent ?? ''
    expect(text.indexOf('/compact')).toBeLessThan(text.indexOf('Your message was not sent.'))
    expect(text.indexOf('Your message was not sent.')).toBeLessThan(text.indexOf('thread busy'))
    expect(count(container, 'Your message was not sent.')).toBe(1)
    expect(count(container, 'thread busy')).toBe(1)
  })

  it("leaves why to a failed start's row", () => {
    const { container } = render(list('startFailed'))
    expect(count(container, 'Your message was not sent.')).toBe(1)
    expect(count(container, 'stopped before it finished starting')).toBe(1)
  })
})
