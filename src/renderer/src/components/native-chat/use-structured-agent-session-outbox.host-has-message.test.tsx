// @vitest-environment happy-dom

// The journal showing a message is the host having it: a composer's saved draft stops holding it
// then, even while the message waits for the provider and its outbox entry stays.

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'
import { whenStructuredAgentSessionHostHasMessages } from './structured-agent-session-message-delivery'

afterEach(cleanup)

const ENTRY = {
  ...createStructuredAgentSessionOutboxEntry({
    clientMessageId: 'message-1',
    sessionId: 'session-1',
    text: 'mid-turn message',
    attachments: [],
    queuedAt: 1
  }),
  state: 'unconfirmed' as const,
  lastAttemptAt: 5
}

function pending(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 10,
    resolvedAt: null
  }
}

beforeEach(() => {
  localStorage.clear()
  mocks.call.mockReset()
  mocks.call.mockImplementation(() => new Promise(() => {}))
})

it('releases the saved draft when the journal shows the host holds the message', async () => {
  writeOutbox('session-1', [ENTRY])
  let hostHasIt = false
  void whenStructuredAgentSessionHostHasMessages('session-1', [ENTRY]).then(() => {
    hostHasIt = true
  })
  type Props = { submissions: AgentJournalSubmission[] }
  const noSubmissions: AgentJournalSubmission[] = []
  const view = renderHook(
    (props: Props) =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: { kind: 'local' },
        fence: 1,
        submissions: props.submissions,
        composerScopeKey: 'scope',
        queueDelivery: { capability: 'supported', enabled: true }
      }),
    { initialProps: { submissions: noSubmissions } }
  )
  expect(hostHasIt).toBe(false)

  view.rerender({ submissions: [pending('message-1')] })

  await waitFor(() => expect(hostHasIt).toBe(true))
  expect(view.result.current.outbox.map((entry) => entry.clientMessageId)).toEqual(['message-1'])
})
