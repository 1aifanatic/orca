// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import { useStructuredAgentSessionStartFailureKeys } from './use-structured-agent-session-start-failure-keys'

function startFailureRow(startKey: string): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity(startKey)),
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords(
        { kind: 'providerStartFailed' },
        { agentName: 'Claude', surface: 'row' }
      )
    }
  }
}

// A streaming turn hands over a new item list on every delta; the keys must not follow it.
it('holds the same keys while the start rows name no new start', () => {
  const row = startFailureRow('gen-1')
  const { result, rerender } = renderHook(
    ({ items }) => useStructuredAgentSessionStartFailureKeys(items, true),
    { initialProps: { items: [row] } }
  )
  const first = result.current
  expect(first).toEqual(['gen-1'])

  rerender({ items: [row, startFailureRow('other-start')] })
  expect(result.current).not.toBe(first)
  const second = result.current

  rerender({ items: [row, startFailureRow('other-start')] })
  expect(result.current).toBe(second)
})
