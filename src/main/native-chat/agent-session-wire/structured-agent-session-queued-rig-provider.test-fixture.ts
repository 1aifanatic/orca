// The provider calls the mid-turn queue rig answers on its own: each a mock a suite can inspect
// or re-program.

import { vi, type Mock } from 'vitest'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

export function createQueuedRigProviderMocks() {
  // Admitted: the message is written and unanswered, so the session owes work
  // until the test settles it.
  const dispatch: Mock<StructuredAgentSessionAdapter['dispatch']> = vi.fn(async () => ({
    state: 'admitted' as const
  }))
  const awaitStarted: Mock<NonNullable<StructuredAgentSessionAdapter['awaitStarted']>> = vi.fn(
    async () => undefined
  )
  // The provider's receipt of a /compact; its end arrives later, as `finishCompact` writes it.
  const compact: Mock<NonNullable<StructuredAgentSessionAdapter['compact']>> = vi.fn(async () => ({
    state: 'accepted' as const,
    providerIdentity: null
  }))
  const cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']> = vi.fn(async () => ({
    cancelled: true
  }))
  const closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>> = vi.fn(
    async () => true
  )
  return { dispatch, awaitStarted, compact, cancelTurn, closeSession }
}
