import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  agentSessionReadFailureText,
  callAgentSession,
  requestStructuredAgentSessionMutation
} from './mobile-structured-agent-session-rpc'

// As `mapRuntimeError` sends a thrown refusal (pinned in `src/main/runtime/rpc/errors.test.ts`):
// its message is the bare code, and its reason rides in data.
const THROWN_OWNER_REFUSAL = {
  code: 'runtime_error',
  message: 'agent_session_journal_unreadable',
  data: {
    refusal: {
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalOwnedElsewhere', processKind: 'packaged' }
    }
  }
}

function refusingClient(): RpcClient {
  const sendRequest = async () => ({ id: 'req-1', ok: false, error: THROWN_OWNER_REFUSAL })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the paths under test reach only `sendRequest`.
  return { sendRequest } as unknown as RpcClient
}

describe('a refusal the host threw', () => {
  it("reads a chat's history failure in the refusal's words, from a stream or a request", async () => {
    const words =
      "Chats are open in another Orca using this profile. This chat's history couldn't be loaded. Quit that Orca to use chats here."
    // The stream's error frame, as the RPC client hands it over.
    expect(
      agentSessionReadFailureText({
        type: 'error',
        message: THROWN_OWNER_REFUSAL.message,
        error: THROWN_OWNER_REFUSAL
      })
    ).toBe(words)
    const thrown = await callAgentSession(refusingClient(), 'agentSession.history', {}).catch(
      (error: unknown) => error
    )
    expect(agentSessionReadFailureText(thrown)).toBe(words)
    expect(agentSessionReadFailureText({ type: 'error', message: 'Connection interrupted' })).toBe(
      'Connection interrupted'
    )
  })

  it("fails a write with the refusal's words, not as unconfirmed", async () => {
    const result = await requestStructuredAgentSessionMutation({
      client: refusingClient(),
      method: 'agentSession.cancel',
      fingerprintMethod: 'agentSession.cancel',
      sessionId: 'session-1',
      expectedRuntimeFence: 3,
      fields: { turnId: 'turn-1' },
      clientOperationId: `1900000000000-${'c'.repeat(32)}`
    })

    expect(result).toEqual({
      status: 'failed',
      message:
        "Chats are open in another Orca using this profile. The agent wasn't stopped. Quit that Orca to use chats here."
    })
  })
})
