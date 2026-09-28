import { describe, expect, it } from 'vitest'
import { normalizeAgentStatusEvent } from './normalize-agent-status-event'

describe('normalizeAgentStatusEvent', () => {
  it('preserves tool-output provenance for native chat gating', () => {
    const normalized = normalizeAgentStatusEvent({
      paneKey: 'tab-1:1',
      state: 'working',
      prompt: 'inspect the failure',
      agentType: 'claude',
      lastAssistantMessage: 'Exit code 1\nraw output',
      lastAssistantMessageIsToolOutput: true,
      connectionId: null,
      receivedAt: 1,
      stateStartedAt: 1
    })

    expect(normalized?.lastAssistantMessageIsToolOutput).toBe(true)
  })

  // Why: the TUI-exit cleanup reads it to keep a row whose work outlives the CLI.
  it('keeps where the host reports the session running while the row shows work', () => {
    const event = {
      paneKey: 'tab-1:1',
      prompt: 'go',
      agentType: 'codex',
      sessionRunner: 'background-server' as const,
      connectionId: null,
      receivedAt: 1,
      stateStartedAt: 1
    }
    expect(normalizeAgentStatusEvent({ ...event, state: 'working' })?.sessionRunner).toBe(
      'background-server'
    )
    expect(normalizeAgentStatusEvent({ ...event, state: 'done' })?.sessionRunner).toBeUndefined()
  })
})
