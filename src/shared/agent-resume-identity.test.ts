import { describe, expect, it } from 'vitest'
import {
  AGENT_RESUME_IDENTITY_ERROR,
  captureAgentResumeLaunchConfig,
  decodeHookResumeSession,
  isOwnedAgentResumeSession,
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
    expect(session).toMatchObject({ resumeIdentity: { agent, connectionId: null } })
    expect(session && isOwnedAgentResumeSession(agent, session)).toBe(true)
  })

  it('keeps a legacy row without source unresolved, even with a UUID session id', () => {
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
        requireOwnedSession: true,
        cmdOverrides: { claude: 'claude' },
        agentArgs: '--dangerously-skip-permissions',
        platform: 'linux'
      })
    ).toBeNull()
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
