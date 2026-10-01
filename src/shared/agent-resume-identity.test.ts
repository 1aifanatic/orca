import { describe, expect, it } from 'vitest'
import {
  AGENT_RESUME_IDENTITY_ERROR,
  agentResumeIdentityPermits,
  captureAgentResumeLaunchConfig,
  decodeHookResumeSession,
  isOwnedAgentResumeSession,
  providerSessionForResumeRequest,
  savedAgentResumeLaunchConfig
} from './agent-resume-identity'
import { normalizeAgentProviderSession, RESUMABLE_TUI_AGENTS } from './agent-session-resume'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'
import { ProviderSession } from './rpc-contract/agent-session-params'
import { sleepingAgentSessionsByPaneKeySchema } from './workspace-session-sleeping-agents'

const locator = { key: 'session_id', id: 'provider-owned-id' } as const

describe('owned resume record', () => {
  it.each(RESUMABLE_TUI_AGENTS)('records %s from the producing route', (agent) => {
    const session = decodeHookResumeSession(locator, agent, null)
    expect(session).toMatchObject({ resumeIdentity: { agent, connectionId: null } })
    expect(session && isOwnedAgentResumeSession(agent, session)).toBe(true)
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

  it('refuses only unreadable or mismatched ownership, never an absent one', () => {
    expect(agentResumeIdentityPermits('codex', locator)).toBe(true)
    expect(agentResumeIdentityPermits('codex', { ...locator, resumeIdentity: null })).toBe(false)
    const owned = decodeHookResumeSession(locator, 'codex', 'ssh-a')!
    expect(agentResumeIdentityPermits('codex', owned, 'ssh-a')).toBe(true)
    expect(agentResumeIdentityPermits('claude', owned, 'ssh-a')).toBe(false)
    expect(agentResumeIdentityPermits('codex', owned, 'ssh-b')).toBe(false)
  })

  it('prefers settings captured with the owner, then the record settings', () => {
    const captured = { agentCommand: 'captured', agentArgs: '', agentEnv: {} }
    const recordConfig = { agentCommand: 'record', agentArgs: '', agentEnv: {} }
    const owned = captureAgentResumeLaunchConfig(
      decodeHookResumeSession(locator, 'codex', null)!,
      'codex',
      captured
    )
    expect(
      savedAgentResumeLaunchConfig('codex', { providerSession: owned, launchConfig: recordConfig })
    ).toBe(owned.resumeIdentity?.launchConfig)
    expect(
      savedAgentResumeLaunchConfig('claude', { providerSession: owned, launchConfig: recordConfig })
    ).toBe(recordConfig)
    expect(
      savedAgentResumeLaunchConfig('codex', {
        providerSession: locator,
        launchConfig: recordConfig
      })
    ).toBe(recordConfig)
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

  it('preserves invalid ownership as a refusal instead of downgrading it to legacy', () => {
    const session = decodeHookResumeSession(
      { ...locator, resumeIdentity: { agent: 'bogus' } },
      'codex',
      null
    )
    expect(session?.resumeIdentity).toBeNull()
  })

  it('retains provider, host and captured settings across sleeping-record hydration', () => {
    const config = {
      agentCommand: 'codex --model captured',
      agentArgs: '--model captured',
      agentEnv: { PROFILE: 'captured' }
    }
    const session = captureAgentResumeLaunchConfig(
      decodeHookResumeSession(locator, 'codex', 'remote-a')!,
      'codex',
      config
    )
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
    expect(restored.pane.providerSession).toEqual(session)
    expect(isOwnedAgentResumeSession('codex', restored.pane.providerSession, 'remote-b')).toBe(
      false
    )
    expect(normalizeAgentProviderSession(session)).toEqual(session)
    expect(
      captureAgentResumeLaunchConfig(session, 'claude', { ...config, agentCommand: 'claude' })
    ).toEqual(session)
  })

  it('projects a validated locator for older strict RPC decoders', () => {
    const session = decodeHookResumeSession(locator, 'codex', null)!
    expect(ProviderSession.parse(providerSessionForResumeRequest('codex', session))).toEqual(
      locator
    )
  })
})
