import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { OpenCodeAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { createOpenCodeStructuredLaunchResolver } from './opencode-structured-launch-resolution'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'session-opencode',
  workspaceId: 'folder-1',
  hostId: 'local',
  agent: 'opencode',
  providerHandle: null
}

function record(): AgentSessionRecord {
  return {
    schemaVersion: 2,
    sessionId: identity.sessionId,
    provider: 'opencode',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder-1',
      workspaceKind: 'folder'
    },
    accountHome: {
      kind: 'opencode',
      locator: {
        kind: 'unmanaged',
        dataHome: '/data',
        stateHome: '/state',
        databaseSelection: { kind: 'override', value: 'selected.db' }
      }
    },
    providerHandleChain: [
      {
        linkId: 'created',
        origin: 'created',
        observedAt: 1,
        mintedAtFence: 1,
        handle: { transport: 'opencode-serve', agent: 'opencode', nativeId: 'session-native' }
      }
    ],
    options: { model: 'provider/model', mode: 'plan' },
    lease: {
      sessionId: identity.sessionId,
      runtimeKind: 'native',
      runtimeFence: 1,
      handoffStage: null,
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: 0,
      lastRenewedAt: 0,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'claim',
      claimStatus: 'released',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: 1,
    updatedAt: 1
  }
}

function resolver(value: AgentSessionRecord) {
  const resolveWorkspacePath = vi.fn(async () => '/folder/project')
  const resolveCommand = vi.fn(() => '/tools/opencode')
  const resolvePinnedEnvironment = vi.fn(
    (_account: OpenCodeAgentSessionAccountHome, environment: Record<string, string>) => ({
      ...environment,
      XDG_DATA_HOME: '/data',
      XDG_STATE_HOME: '/state',
      OPENCODE_DB: 'selected.db'
    })
  )
  return {
    resolveWorkspacePath,
    resolveCommand,
    resolvePinnedEnvironment,
    run: createOpenCodeStructuredLaunchResolver({
      store: { getRecord: () => value },
      resolveWorkspacePath,
      resolveCommand,
      resolvePinnedEnvironment,
      resolveEnvironment: async () => ({
        PATH: '/login/bin',
        HOME: '/login/home',
        XDG_DATA_HOME: '/later'
      }),
      resolveLaunchEnv: () => ({ PATH: '/configured/bin' })
    })
  }
}

describe('OpenCode execution-host launch identity', () => {
  it('resolves a folder workspace and pinned account after current launch overlays', async () => {
    const value = record()
    const launch = resolver(value)
    expect(await launch.run({ identity })).toMatchObject({
      command: '/tools/opencode',
      cwd: '/folder/project',
      agent: 'opencode',
      resumeSessionId: 'session-native',
      options: { model: 'provider/model', mode: 'plan' },
      environment: { PATH: '/configured/bin', XDG_DATA_HOME: '/data', OPENCODE_DB: 'selected.db' }
    })
    expect(launch.resolveWorkspacePath).toHaveBeenCalledWith('folder-1')
    expect(launch.resolvePinnedEnvironment).toHaveBeenCalledWith(
      value.accountHome,
      expect.objectContaining({ XDG_DATA_HOME: '/later' })
    )
    expect(launch.resolveCommand).toHaveBeenCalledWith('opencode', {
      pathEnv: '/configured/bin',
      homePath: '/login/home'
    })
  })

  it.each(['ssh:remote', 'wsl'] as const)(
    'refuses to own a %s execution from this host before resolving its filesystem',
    async (location) => {
      const value = record()
      if (location === 'wsl') {
        value.location.wslDistro = 'Ubuntu'
      } else {
        value.location.executionHostId = location
      }
      const launch = resolver(value)
      await expect(launch.run({ identity })).rejects.toThrow('host that owns')
      expect(launch.resolveWorkspacePath).not.toHaveBeenCalled()
      expect(launch.resolvePinnedEnvironment).not.toHaveBeenCalled()
    }
  )

  it('rejects an ACP conversation before it can be resumed through server mode', async () => {
    const value = record()
    value.providerHandleChain[0]!.handle = {
      transport: 'acp',
      agent: 'opencode',
      nativeId: 'session-native'
    }
    const launch = resolver(value)
    await expect(launch.run({ identity })).rejects.toThrow('different transport')
    expect(launch.resolveWorkspacePath).not.toHaveBeenCalled()
  })

  it('refuses an older single-directory binding rather than silently changing account', async () => {
    const value = record()
    value.accountHome = { variable: 'OPENCODE_HOME', path: '/old' }
    await expect(resolver(value).run({ identity })).rejects.toThrow('pinned data account')
  })
})
