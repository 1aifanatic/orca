import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  onStructuredAgentSessionHostInstalled,
  setStructuredAgentSessionHost
} from './structured-agent-session-registry'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry only holds the reference.
const HOST = {} as StructuredAgentSessionHost

afterEach(() => {
  setStructuredAgentSessionHost(null)
})

// The renderer mirrors this machine's chats once the host exists, e.g. when a paired client
// creates the first chat here while the chat setting is off.
describe('the structured host install signal', () => {
  it('fires once when a host is installed where there was none', () => {
    const listener = vi.fn()
    const stop = onStructuredAgentSessionHostInstalled(listener)

    setStructuredAgentSessionHost(HOST)
    setStructuredAgentSessionHost(HOST)

    expect(listener).toHaveBeenCalledOnce()
    stop()
  })

  it('does not fire when the host is torn down', () => {
    setStructuredAgentSessionHost(HOST)
    const listener = vi.fn()
    const stop = onStructuredAgentSessionHostInstalled(listener)

    setStructuredAgentSessionHost(null)

    expect(listener).not.toHaveBeenCalled()
    stop()
  })
})
