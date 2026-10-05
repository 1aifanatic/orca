// A close must not wait behind a start the provider never answers: the start runs under the
// session's queue, and the close's own stop is queued behind it.

import { expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  adapter,
  attachParams,
  CALLER,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'

it('a close stops a start the provider never answers instead of queueing behind it', async () => {
  const state = hostTestState()
  let failStart: ((error: Error) => void) | undefined
  state.acquire.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        failStart = reject
      })
  )
  // The provider's child stops, so its unanswered handshake fails the start.
  const abandonStart = vi.fn(async () => failStart?.(new Error('closed while starting')))
  const host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: createStructuredAgentSessionLogger(),
    store: state.store,
    adapter: { ...adapter(), abandonStart },
    journalDatabase: openTestJournalHostDatabase(state.root),
    recoveryCapsule: new AgentSessionRecoveryCapsule(state.root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => HOST_TEST_NOW
  })
  replaceHostTestState({ store: state.store, host })
  const attaching = host.attach(CALLER, attachParams())
  await vi.waitFor(() => expect(state.acquire).toHaveBeenCalled())
  await host.close(SESSION, 'user-close')
  expect(abandonStart).toHaveBeenCalledWith(SESSION)
  expect((await attaching).ok).toBe(false)
})
