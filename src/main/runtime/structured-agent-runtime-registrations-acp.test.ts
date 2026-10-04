import { describe, expect, it } from 'vitest'
import {
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
  STRUCTURED_AGENT_STORAGE,
  structuredAgentRuntimeRegistration
} from './structured-agent-runtime-registrations'

describe('ACP agents in the runtime registrations', () => {
  it('registers Grok beside Claude and Codex with its declared capabilities', () => {
    expect(
      STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(({ definition }) => definition.agent)
    ).toEqual(['codex', 'claude', 'grok'])
    expect(structuredAgentRuntimeRegistration('grok')?.definition).toMatchObject({
      handleTransport: 'acp',
      accountHomeVariable: 'GROK_HOME',
      capabilities: {
        rewind: false,
        compact: false,
        threadGoal: false,
        contextUsage: true,
        imagePrompts: false,
        steering: 'queue',
        approvalEnforcement: 'orca'
      }
    })
  })

  it('admits Grok records under the protocol transport and its config home variable', () => {
    expect(STRUCTURED_AGENT_STORAGE.get('grok')).toEqual({
      agent: 'grok',
      handleTransport: 'acp',
      accountHomeVariable: 'GROK_HOME'
    })
  })

  it('takes model and effort picks at rest, and keeps no model list of its own', () => {
    const resting = structuredAgentRuntimeRegistration('grok')!.definition.restingOptions
    expect(['model', 'effort'].map(resting.acceptsKey)).toEqual([true, true])
    expect(resting.acceptsKey('fastMode')).toBe(false)
    expect(resting.fallbackModels()).toBeNull()
  })

  it('finds the account home on this runtime from the launch env, else the default', () => {
    const resolve = structuredAgentRuntimeRegistration('grok')!.resolveAccountHomePath!
    expect(resolve({ launchEnv: { GROK_HOME: '/data/grok' } })).toBe('/data/grok')
    expect(resolve({ launchEnv: { GROK_HOME: 'relative/grok' } })).toMatch(/\.grok$/)
    expect(structuredAgentRuntimeRegistration('claude')?.resolveAccountHomePath).toBeUndefined()
  })
})
