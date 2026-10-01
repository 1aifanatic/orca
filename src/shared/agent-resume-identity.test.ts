import { describe, expect, it } from 'vitest'
import {
  resolveResumeAgent,
  decodeHookResumeSession,
  providerSessionForResumeRequest,
  sameResumeTarget
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
    expect(session && resolveResumeAgent(agent, session)).toBe(agent)
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

  it('resolves the route owner ahead of the displayed agent', () => {
    expect(resolveResumeAgent('codex', locator)).toBe('codex')
    const owned = decodeHookResumeSession(locator, 'codex', 'ssh-a')!
    expect(owned.resumeIdentity).toEqual({ agent: 'codex' })
    expect(resolveResumeAgent('codex', owned)).toBe('codex')
    expect(resolveResumeAgent('claude', owned)).toBe('codex')
  })

  it('resumes a saved mixed identity with its owner and current settings', () => {
    const session = decodeHookResumeSession(locator, 'codex', null)!
    expect(
      buildAgentResumeStartupPlan({
        agent: 'claude',
        providerSession: session,
        cmdOverrides: { codex: '/opt/codex' },
        agentCommand: 'claude --old',
        agentArgs: '--claude-only',
        agentEnv: { CLAUDE_ONLY: '1' },
        agentDefaultArgs: { codex: '--codex-current' },
        agentDefaultEnv: { codex: { CODEX_CURRENT: '1' } },
        platform: 'linux'
      })
    ).toMatchObject({
      agent: 'codex',
      launchCommand: "/opt/codex '--codex-current' 'resume' 'provider-owned-id'",
      env: { CODEX_CURRENT: '1' }
    })
    expect(providerSessionForResumeRequest(session)).toEqual(locator)
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
      expect(resolveResumeAgent('claude', legacy)).toBe('claude')
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

  it('matches resume targets by owning agent, not display label', () => {
    const owned = decodeHookResumeSession(locator, 'codex', null)!
    expect(sameResumeTarget('claude', owned, 'codex', owned)).toBe(true)
    expect(sameResumeTarget('claude', owned, 'codex', locator)).toBe(true)
    expect(sameResumeTarget('claude', owned, 'claude', locator)).toBe(false)
    expect(sameResumeTarget('claude', locator, 'codex', locator)).toBe(false)
    expect(sameResumeTarget('claude', locator, 'claude', locator)).toBe(true)
    expect(sameResumeTarget(undefined, locator, undefined, locator)).toBe(false)
    expect(sameResumeTarget('codex', owned, 'codex', undefined)).toBe(false)
  })

  it('projects a validated locator for older strict RPC decoders', () => {
    const session = decodeHookResumeSession(locator, 'codex', null)!
    expect(ProviderSession.parse(providerSessionForResumeRequest(session))).toEqual(locator)
  })
})
