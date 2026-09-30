// The host's own structured-chat setting is its user's launch preference, not admission control:
// a paired client that can read structured sessions reaches every method whatever that setting says.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  CLEANUP_METHODS,
  WORK_METHODS
} from './structured-agent-session-gate-classification.test-fixture'
import {
  call,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => {
  installStructuredHostStub()
})

afterEach(() => {
  clearStructuredHostStub()
})

const SETTING_OFF = { getClientSettings: () => ({ experimentalStructuredNativeChat: false }) }
const UNSUPPORTED = { message: expect.stringContaining('structured_agent_session_unsupported') }

describe('a host with structured chat turned off', () => {
  it.each(WORK_METHODS)('still serves $method to a capable client', async ({ method, params }) => {
    const response = await call(method, params, STRUCTURED_CLIENT, SETTING_OFF).catch(
      (error: Error) => {
        // An admitted stream the stub never feeds answers nothing; a refused one replies at once.
        expect(error.message).toBe(`no reply for ${method}`)
        return null
      }
    )

    // Other failures are the stub's business; the one this pins is the gate's own refusal.
    expect(response).not.toMatchObject({ ok: false, error: UNSUPPORTED })
  })

  it.each(CLEANUP_METHODS)('still serves $method to a capable client', async (entry) => {
    const response = await call(entry.method, entry.params, STRUCTURED_CLIENT, SETTING_OFF)

    expect(response).toMatchObject({ ok: true })
    // `unsubscribe` retires runtime-owned subscriptions and `release` is a no-op, so neither
    // calls the host: the result payload is the observable effect.
    if (entry.hostCall === null) {
      expect(response).toMatchObject({ result: entry.result })
    } else {
      expect(hostCalls[entry.hostCall]).toHaveBeenCalled()
    }
  })

  it('creates a session for a paired client', async () => {
    const create = WORK_METHODS.find((entry) => entry.method === 'agentSession.create')!
    const response = await call(create.method, create.params, STRUCTURED_CLIENT, SETTING_OFF)

    expect(response).toMatchObject({ ok: true })
  })

  it('stops the provider child and retires the tab when a chat is closed', async () => {
    const response = await call(
      'agentSession.close',
      { sessionId: SESSION },
      STRUCTURED_CLIENT,
      SETTING_OFF
    )

    expect(response).toMatchObject({ ok: true, result: { ok: true } })
    expect(hostCalls.close).toHaveBeenCalledWith(SESSION)
    // The durable tab has to be retired too, or the chat comes back on the next sync.
    expect(hostCalls.setSessionTabVisibility).toHaveBeenCalledWith(SESSION, false)
  })

  it('cancels an in-flight turn', async () => {
    const response = await call(
      'agentSession.cancel',
      { envelope: envelope(), turnId: 'turn-1' },
      STRUCTURED_CLIENT,
      SETTING_OFF
    )

    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.cancel).toHaveBeenCalledOnce()
  })

  it.each([...WORK_METHODS, ...CLEANUP_METHODS])(
    'refuses $method to a client that never advertised the capability',
    async ({ method, params }) => {
      const response = await call(
        method,
        params,
        { clientKind: 'runtime', clientCapabilities: [] },
        { getClientSettings: () => ({ experimentalStructuredNativeChat: true }) }
      )

      // Asserting the gate's own code, not merely `ok: false`: a params-validation failure would
      // pass a bare falsy check and hide a gate that had stopped refusing.
      expect(response).toMatchObject({ ok: false, error: UNSUPPORTED })
    }
  )

  it.each(['runtime', 'mobile'] as const)(
    'lets a %s client close a chat it already owns',
    async (clientKind) => {
      const response = await call(
        'agentSession.close',
        { sessionId: SESSION },
        { clientKind, clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] },
        SETTING_OFF
      )

      expect(response).toMatchObject({ ok: true })
      expect(hostCalls.close).toHaveBeenCalledWith(SESSION)
    }
  )
})
