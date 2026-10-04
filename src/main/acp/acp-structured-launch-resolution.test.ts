import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { createProviderSpawnSpec } from '../provider-process/provider-process-supervisor'
import { ACP_CHILD_ENV_TO_DELETE, acpLaunchSpecFor } from './acp-launch-specs'
import { createAcpStructuredLaunchResolver } from './acp-structured-launch-resolution'

const GROK = acpLaunchSpecFor('grok')!
const identity = {
  sessionId: 'session-alpha-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'grok',
  providerHandle: null
}

function grokRecord(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(),
    provider: 'grok',
    providerHandleChain: [],
    accountHome: { variable: 'GROK_HOME', path: '/home/user/.grok-work' },
    ...overrides
  }
}

function resolver(record: AgentSessionRecord, fullAccess = false) {
  const searched: (string | null | undefined)[] = []
  return {
    searched,
    resolve: createAcpStructuredLaunchResolver(GROK, {
      store: { getRecord: () => record },
      resolveWorkspacePath: async () => '/repo/worktree',
      resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
      resolveLaunchEnv: () => ({ GROK_EXTRA: '1' }),
      resolveFullAccess: () => fullAccess,
      resolveCommand: (command, options) => {
        searched.push(options?.pathEnv)
        return `/resolved/${command}`
      }
    })
  }
}

describe('ACP launch resolution', () => {
  it('pins the record account home, never self-updates, and searches the agent install dir', async () => {
    const { resolve, searched } = resolver(grokRecord())
    const launch = await resolve({ identity })
    expect(launch).toMatchObject({
      command: '/resolved/grok',
      args: ['--no-auto-update', 'agent', '--no-leader', 'stdio'],
      cwd: '/repo/worktree',
      fullAccess: false,
      resume: null
    })
    expect(launch.env).toMatchObject({
      GROK_HOME: '/home/user/.grok-work',
      GROK_DISABLE_AUTOUPDATER: '1',
      GROK_EXTRA: '1'
    })
    expect(searched[0]).toContain('/home/user/.grok-work/bin')
  })

  it('asks the agent to approve everything only under full access', async () => {
    const launch = await resolver(grokRecord(), true).resolve({ identity })
    expect(launch.args).toContain('--always-approve')
  })

  it('resumes the chain head, replaceable only when this chat created it', async () => {
    const link = (origin: 'created' | 'resumed') => ({
      linkId: `link-${origin}`,
      origin,
      mintedAtFence: 1,
      observedAt: 1,
      handle: { transport: 'acp', agent: 'grok', nativeId: 'acp-1' }
    })
    const created = await resolver(grokRecord({ providerHandleChain: [link('created')] })).resolve({
      identity
    })
    expect(created.resume).toMatchObject({ sessionId: 'acp-1' })
    expect(created.resume?.replaceableKey).toEqual(expect.any(String))
    const resumed = await resolver(
      grokRecord({ providerHandleChain: [link('created'), link('resumed')] })
    ).resolve({ identity })
    expect(resumed.resume).toEqual({ sessionId: 'acp-1', replaceableKey: null })
  })

  it('refuses a record pinned to another host or another agent', async () => {
    const remote = grokRecord()
    remote.location = { ...remote.location, executionHostId: 'ssh:box' }
    await expect(resolver(remote).resolve({ identity })).rejects.toThrow(/run on this runtime/)
    await expect(resolver(agentSessionRecordFixture()).resolve({ identity })).rejects.toThrow(
      /claude session/
    )
  })
})

describe('Grok status: the structured session is the only producer', () => {
  it('strips every pane identity and hook endpoint an inherited environment carries', () => {
    const inherited = {
      PATH: '/usr/bin',
      ORCA_PANE_KEY: 'tab-1:pane-1',
      ORCA_AGENT_PANE: 'tab-1:pane-1',
      ORCA_TAB_ID: 'tab-1',
      ORCA_WORKTREE_ID: 'wt-1',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch-1',
      ORCA_AGENT_HOOK_PORT: '4321',
      ORCA_AGENT_HOOK_TOKEN: 'secret',
      ORCA_AGENT_HOOK_ENDPOINT: '/tmp/endpoint'
    }
    const spec = createProviderSpawnSpec(
      {
        command: 'grok',
        args: ['agent', 'stdio'],
        env: { GROK_HOME: '/home/user/.grok' },
        envToDelete: ACP_CHILD_ENV_TO_DELETE
      },
      inherited,
      'win32'
    )
    expect(Object.keys(spec.env).filter((key) => key.startsWith('ORCA_'))).toEqual([])
    expect(spec.env).toMatchObject({ PATH: '/usr/bin', GROK_HOME: '/home/user/.grok' })
  })
})
