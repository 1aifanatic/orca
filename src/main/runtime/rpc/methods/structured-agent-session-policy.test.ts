import { describe, expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { supportsStructuredAgentSessions } from './structured-agent-session-policy'

const CAPABLE = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]

describe('supportsStructuredAgentSessions', () => {
  it.each(['runtime', 'mobile'] as const)(
    'admits a %s client that advertises the capability',
    (clientKind) => {
      expect(supportsStructuredAgentSessions({ clientKind, clientCapabilities: CAPABLE })).toBe(
        true
      )
    }
  )

  it('admits a capability-less in-process caller, which negotiates nothing', () => {
    expect(
      supportsStructuredAgentSessions({ clientKind: undefined, clientCapabilities: undefined })
    ).toBe(true)
  })

  it.each(['runtime', 'mobile'] as const)(
    'refuses a %s client that did not advertise the capability',
    (clientKind) => {
      expect(supportsStructuredAgentSessions({ clientKind, clientCapabilities: [] })).toBe(false)
      expect(supportsStructuredAgentSessions({ clientKind, clientCapabilities: undefined })).toBe(
        false
      )
    }
  )
})
