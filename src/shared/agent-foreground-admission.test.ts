import { describe, expect, it } from 'vitest'
import { admitAgentForeground } from './agent-foreground-admission'
import { transitionHookPresence } from './agent-hook-presence-transition'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'

const scope = { paneKey: 'pane', connectionId: null, worktreeId: 'folder' }
const presence = {
  agent: 'codex',
  process: { pid: 42, platform: 'linux', startTime: 'boot:1' }
} as const
const turn: AgentHookEventPayload = {
  ...scope,
  payload: { state: 'waiting', prompt: 'approve this', agentType: 'codex' }
}

describe('foreground admission into the sole owner store', () => {
  it('publishes identity without inventing a turn', () => {
    expect(admitAgentForeground(undefined, presence, scope)).toMatchObject({
      providerSessionOnly: true,
      agentPresence: presence
    })
  })
  it('retains a permission prompt and turn metadata', () => {
    const admitted = admitAgentForeground(turn, presence, scope)
    expect(admitted?.payload).toBe(turn.payload)
    expect(admitted?.providerSessionOnly).toBeUndefined()
  })
  it('never replaces a live owner, even when the same brand has another process', () => {
    const before = { ...turn, agentPresence: presence }
    expect(
      admitAgentForeground(
        before,
        { ...presence, process: { ...presence.process, startTime: 'boot:2' } },
        scope
      )
    ).toBeUndefined()
    expect(admitAgentForeground(before, presence, scope)).toBeUndefined()
  })
  it('accepts a successor only after proven exit and refuses another host or workspace', () => {
    const before = { ...turn, agentPresence: { ...presence, ended: true as const } }
    expect(
      admitAgentForeground(
        before,
        { ...presence, process: { ...presence.process, startTime: 'boot:2' } },
        scope
      )?.providerSessionOnly
    ).toBe(true)
    expect(admitAgentForeground(turn, presence, { ...scope, connectionId: 'ssh' })).toBeUndefined()
    expect(admitAgentForeground(turn, presence, { ...scope, worktreeId: 'other' })).toBeUndefined()
  })
  it('hooks cannot create, replace or end process ownership', () => {
    const forged = { ...turn, agentPresence: { ...presence, ended: true as const } }
    expect(transitionHookPresence(forged, undefined)?.agentPresence).toBeUndefined()
    expect(
      transitionHookPresence(forged, { ...turn, agentPresence: presence })?.agentPresence
    ).toBe(presence)
  })
})
