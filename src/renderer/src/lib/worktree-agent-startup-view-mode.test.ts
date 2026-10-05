import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../shared/tui-agent'
import { backendAgentStartup } from './worktree-agent-startup-view-mode'

const initialSettings = useAppStore.getState().settings!
const initialRepos = useAppStore.getState().repos

const DRAFT = 'https://github.com/o/r/issues/12'

function setRepoConnection(connectionId: string | null): void {
  useAppStore.setState({
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 1,
        connectionId
      }
    ]
  })
}

function viewModeFor(agent: TuiAgent): string | undefined {
  return backendAgentStartup({
    repoId: 'repo-1',
    agent,
    startup: { command: agent },
    launchDraftPrompt: DRAFT
  })?.viewMode
}

beforeEach(() => {
  useAppStore.setState({
    settings: {
      ...initialSettings,
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
  })
})

afterEach(() => {
  useAppStore.setState({ settings: initialSettings, repos: initialRepos })
})

describe('backendAgentStartup', () => {
  // Why: omp discloses no hook transcript path, so it joins Grok in requiring a
  // locally readable sessions root. This call site must SUPPLY that flag for omp
  // too — gating on Grok alone left it undefined and parked every omp draft in
  // the terminal view, local workspace or not.
  it('opens a local omp draft in chat', () => {
    setRepoConnection(null)
    expect(viewModeFor('omp')).toBe('chat')
  })

  it('keeps a Model-A SSH omp draft in the terminal view', () => {
    setRepoConnection('ssh-target-1')
    expect(viewModeFor('omp')).toBe('terminal')
  })

  it('opens a runtime-owned SSH omp draft in chat, which reads the transcript locally', () => {
    setRepoConnection('runtime-ssh-env-1')
    expect(viewModeFor('omp')).toBe('chat')
  })
})

describe('backendAgentStartup for a launch with no draft (STA-6412)', () => {
  it("stamps this device's chat default on a prompt-less agent startup", () => {
    setRepoConnection(null)
    const startup = backendAgentStartup({
      repoId: 'repo-1',
      agent: 'claude',
      startup: { command: 'claude' }
    })
    expect(startup?.viewMode).toBe('chat')
  })

  it('stamps explicit terminal when this device does not default to chat', () => {
    setRepoConnection(null)
    useAppStore.setState({
      settings: {
        ...initialSettings,
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: false
      }
    })
    const startup = backendAgentStartup({
      repoId: 'repo-1',
      agent: 'claude',
      startup: { command: 'claude' }
    })
    expect(startup?.viewMode).toBe('terminal')
  })
})
