import { describe, expect, it } from 'vitest'
import { withFinalAgentTabStartingView, withWorktreeStartupView } from './agent-tab-starting-view'

const CHAT_DEFAULT = { experimentalNativeChat: true, openAgentTabsInChatByDefault: true }

describe('withFinalAgentTabStartingView', () => {
  it("finalizes on this workspace's route: a Model-A SSH grok transcript cannot show chat", () => {
    expect(
      withFinalAgentTabStartingView(
        { launchAgent: 'grok' },
        { connectionId: 'ssh-1' },
        CHAT_DEFAULT
      ).viewMode
    ).toBe('terminal')
    expect(
      withFinalAgentTabStartingView({ launchAgent: 'grok' }, { connectionId: null }, CHAT_DEFAULT)
        .viewMode
    ).toBe('chat')
  })

  it("leaves a plain shell's options untouched", () => {
    const launch = { viewMode: 'chat' as const }
    expect(withFinalAgentTabStartingView(launch, { connectionId: null }, CHAT_DEFAULT)).toBe(launch)
  })
})

describe('withWorktreeStartupView (STA-6412 host-built startups)', () => {
  const agentStartup = { startup: { command: 'claude' } }

  it("carries the launcher's view onto a host-built startup that has none", () => {
    expect(withWorktreeStartupView({ startupViewMode: 'chat' }, agentStartup, null)?.viewMode).toBe(
      'chat'
    )
  })

  it("keeps a client-built startup's own view over the request", () => {
    expect(
      withWorktreeStartupView(
        { startup: { command: 'claude', viewMode: 'terminal' }, startupViewMode: 'chat' },
        null,
        null
      )?.viewMode
    ).toBe('terminal')
  })

  it('pins terminal for an unsent draft chat cannot mirror', () => {
    expect(
      withWorktreeStartupView(
        { startupViewMode: 'chat', startupDraft: 'note\u2028issue' },
        null,
        agentStartup
      )?.viewMode
    ).toBe('terminal')
  })

  it('leaves a startup alone when nothing was requested (the host default applies later)', () => {
    expect(withWorktreeStartupView({ startupDraft: 'fix the bug' }, null, agentStartup)).toBe(
      agentStartup.startup
    )
  })
})
