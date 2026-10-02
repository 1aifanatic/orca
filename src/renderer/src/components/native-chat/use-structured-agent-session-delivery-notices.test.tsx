// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { DISPATCH_REJECTED_CANCELLED } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { useStructuredAgentSessionDeliveryNotices } from './use-structured-agent-session-delivery-notices'

afterEach(cleanup)

const NONE = new Set<string>()
const NO_CARDS: readonly string[] = []
const EMPTY: never[] = []

function withdrawn(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'rejected',
    providerItemId: null,
    reason: DISPATCH_REJECTED_CANCELLED,
    rejection: { kind: 'cancelled' },
    submittedAt: 1,
    resolvedAt: 2
  }
}

// A Stop's withdrawn message draws no row, so a chat that has one rebuilds no notice per batch.
it('keeps the same notices across batches in a chat whose only rejection a Stop withdrew', () => {
  const { result, rerender } = renderHook(
    ({ submissions }: { submissions: readonly AgentJournalSubmission[] }) =>
      useStructuredAgentSessionDeliveryNotices({
        outbox: EMPTY,
        submissions,
        journalItems: EMPTY,
        failedHere: NONE,
        queuedMessageIds: NO_CARDS,
        retry: () => {},
        agentName: 'Claude'
      }),
    { initialProps: { submissions: [withdrawn('stopped')] } }
  )
  const first = result.current

  rerender({ submissions: [withdrawn('stopped')] })

  expect(result.current).toBe(first)
  expect(result.current.size).toBe(0)
})
