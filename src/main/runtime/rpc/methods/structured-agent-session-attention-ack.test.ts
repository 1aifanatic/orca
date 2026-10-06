import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => installStructuredHostStub())
afterEach(() => clearStructuredHostStub())

describe('agentSession.acknowledgeAttention', () => {
  it("passes the captured read boundary to this session's owning host", async () => {
    const retire = vi.fn()
    hostCalls.attentionSubjectPrefix.mockReturnValueOnce('agent-attention:scope:session-1:')
    const reply = await call(
      'agentSession.acknowledgeAttention',
      { sessionId: SESSION, observedCursor: { epoch: 'epoch-a', sequence: 10 } },
      STRUCTURED_CLIENT,
      { retireStructuredAttention: retire }
    )
    expect(reply).toMatchObject({ ok: true, result: { acknowledged: true } })
    expect(hostCalls.attentionSubjectPrefix).toHaveBeenCalledWith(SESSION)
    expect(retire).toHaveBeenCalledExactlyOnceWith(
      { sessionId: SESSION, observedCursor: { epoch: 'epoch-a', sequence: 10 } },
      'agent-attention:scope:session-1:'
    )
  })

  it('accepts an older caller without granting a session-wide read or installing a host', async () => {
    setStructuredAgentSessionHost(null)
    const install = vi.fn()
    const retire = vi.fn()
    const reply = await call(
      'agentSession.acknowledgeAttention',
      { sessionId: SESSION },
      STRUCTURED_CLIENT,
      { retireStructuredAttention: retire, ensureStructuredAgentSessionHost: install }
    )
    expect(reply).toMatchObject({ ok: true, result: { acknowledged: false } })
    expect(install).not.toHaveBeenCalled()
    expect(retire).not.toHaveBeenCalled()
    expect(hostCalls.attentionSubjectPrefix).not.toHaveBeenCalled()
  })

  it('retires nothing for a session this host never had', async () => {
    const retire = vi.fn()
    const reply = await call(
      'agentSession.acknowledgeAttention',
      { sessionId: SESSION, observedCursor: { epoch: 'epoch-a', sequence: 10 } },
      STRUCTURED_CLIENT,
      { retireStructuredAttention: retire }
    )
    expect(reply).toMatchObject({ ok: true })
    expect(retire).not.toHaveBeenCalled()
  })
  it.each(['cursorless', 'bounded'] as const)(
    'rejects a caller without structured capability before any host work (%s)',
    async (mode) => {
      setStructuredAgentSessionHost(null)
      const install = vi.fn()
      const retire = vi.fn()
      const reply = await call(
        'agentSession.acknowledgeAttention',
        {
          sessionId: SESSION,
          ...(mode === 'bounded' ? { observedCursor: { epoch: 'epoch-a', sequence: 10 } } : {})
        },
        { clientKind: 'runtime', clientCapabilities: [] },
        { retireStructuredAttention: retire, ensureStructuredAgentSessionHost: install }
      )
      expect(reply).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('structured_agent_session_unsupported') }
      })
      expect(install).not.toHaveBeenCalled()
      expect(retire).not.toHaveBeenCalled()
      expect(hostCalls.attentionSubjectPrefix).not.toHaveBeenCalled()
    }
  )
})
