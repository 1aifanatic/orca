import { describe, expect, it } from 'vitest'
import {
  AGENT_RESUME_IDENTITY_ERROR,
  agentResumeIdentityPermits,
  decodeHookResumeSession,
  providerSessionForResumeRequest
} from './agent-resume-identity'
import { normalizeAgentProviderSession, RESUMABLE_TUI_AGENTS } from './agent-session-resume'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'
import { ProviderSession } from './rpc-contract/agent-session-params'
import { sleepingAgentSessionsByPaneKeySchema } from './workspace-session-sleeping-agents'

const locator = { key: 'session_id', id: 'provider-owned-id' } as const

describe('owned resume record', () => {
  it.each(RESUMABLE_TUI_AGENTS)('records %s from the producing route', (agent) => {
    const session = decodeHookResumeSession(locator, agent, null)
    expect(session?.resumeIdentity).toEqual({ agent })
    expect(session && agentResumeIdentityPermits(agent, session)).toBe(true)
  })

  it('keeps a legacy row without source unresolved, and resumes it as before', () => {
    const session = decodeHookResumeSession(
      { ...locator, id: '0195f2ce-1111-4000-8000-000000000001' },
      undefined,
      null
    )
    expect(session?.resumeIdentity).toBeUndefined()
    expect(
      buildAgentResumeStartupPlan({
        agent: 'claude',
        providerSession: session!,
        cmdOverrides: { claude: '/opt/custom/claude' },
        agentArgs: '--dangerously-skip-permissions',
        platform: 'linux'
      })?.launchCommand
    ).toBe(
      "/opt/custom/claude '--dangerously-skip-permissions' '--resume' '0195f2ce-1111-4000-8000-000000000001'"
    )
  })

  it('refuses only an identity naming another agent', () => {
    expect(agentResumeIdentityPermits('codex', locator)).toBe(true)
    const owned = decodeHookResumeSession(locator, 'codex', 'ssh-a')!
    expect(owned.resumeIdentity).toEqual({ agent: 'codex' })
    expect(agentResumeIdentityPermits('codex', owned)).toBe(true)
    expect(agentResumeIdentityPermits('claude', owned)).toBe(false)
  })

  it('refuses a saved mixed identity rather than relabeling it', () => {
    const session = decodeHookResumeSession(locator, 'codex', null)!
    expect(
      buildAgentResumeStartupPlan({
        agent: 'claude',
        providerSession: session,
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toBeNull()
    expect(() => providerSessionForResumeRequest('claude', session)).toThrow(
      AGENT_RESUME_IDENTITY_ERROR
    )
  })

  it.each([{ agent: 'bogus' }, 'codex', 42, { connectionId: null }])(
    'reads a malformed identity %j as absent and re-derives it from the route',
    (resumeIdentity) => {
      const raw = { ...locator, resumeIdentity }
      expect(normalizeAgentProviderSession(raw)).toEqual(locator)
      expect(decodeHookResumeSession(raw, 'codex', null)?.resumeIdentity).toEqual({
        agent: 'codex'
      })
      const legacy = decodeHookResumeSession(raw, undefined, null)!
      expect(legacy.resumeIdentity).toBeUndefined()
      expect(agentResumeIdentityPermits('claude', legacy)).toBe(true)
    }
  )

  it('retains the provider across sleeping-record hydration', () => {
    const session = decodeHookResumeSession(locator, 'codex', 'remote-a')!
    const record = {
      paneKey: 'pane',
      worktreeId: 'folder-workspace',
      agent: 'codex',
      providerSession: session,
      prompt: 'work',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1
    }
    const restored = sleepingAgentSessionsByPaneKeySchema.parse(
      JSON.parse(JSON.stringify({ pane: record }))
    )
    if (!restored) {
      throw new Error('Sleeping record was discarded')
    }
    expect(restored.pane.providerSession).toEqual({
      ...locator,
      resumeIdentity: { agent: 'codex' }
    })
    expect(normalizeAgentProviderSession(session)).toEqual(session)
  })

  it('projects a validated locator for older strict RPC decoders', () => {
    const session = decodeHookResumeSession(locator, 'codex', null)!
    expect(ProviderSession.parse(providerSessionForResumeRequest('codex', session))).toEqual(
      locator
    )
  })
})
