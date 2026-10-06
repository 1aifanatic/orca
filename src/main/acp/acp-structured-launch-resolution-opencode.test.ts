import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { ManagedDataAccountsState } from '../../shared/managed-account-types'
import { restoreManagedDataAccountEnvironment } from '../../shared/managed-data-account-environment'
import { createProviderSpawnSpec } from '../provider-process/provider-process-supervisor'
import { openCodeAcpAccountBinding } from '../opencode/opencode-structured-account-home'
import { ACP_CHILD_ENV_TO_DELETE, acpLaunchSpecFor } from './acp-launch-specs'
import { createAcpStructuredLaunchResolver } from './acp-structured-launch-resolution'

const PROFILE = '123e4567-e89b-42d3-a456-426614174000'

let activeAccountId: string | null = PROFILE
const managedAccounts = {
  list: (): ManagedDataAccountsState => ({
    accounts: [{ id: PROFILE, label: 'work', integrations: [], createdAt: 0 }],
    activeAccountId
  }),
  restoreOriginalEnvironment: (environment: Record<string, string | undefined>) =>
    restoreManagedDataAccountEnvironment(environment),
  environmentForAccount: (_provider: 'opencode' | 'devin', id: string) => ({
    XDG_DATA_HOME: `/profiles/${id}/data`,
    XDG_STATE_HOME: `/profiles/${id}/state`,
    OPENCODE_DB: 'opencode.db',
    OPENCODE_AUTH_CONTENT: ''
  })
}

const OPENCODE = {
  ...acpLaunchSpecFor('opencode')!,
  account: openCodeAcpAccountBinding({ managedProfiles: true }, () => managedAccounts)
}
const OPENCODE2_ACCOUNT = openCodeAcpAccountBinding(
  { managedProfiles: false },
  () => managedAccounts
)
const identity = {
  sessionId: 'session-alpha-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'opencode',
  providerHandle: null
}

function openCodeRecord(accountHome: AgentSessionRecord['accountHome']): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(),
    provider: 'opencode',
    providerHandleChain: [],
    accountHome
  }
}

const UNMANAGED: AgentSessionRecord['accountHome'] = {
  kind: 'opencode',
  locator: {
    kind: 'unmanaged',
    dataHome: '/home/user/.local/share',
    stateHome: '/home/user/.local/state',
    databaseSelection: { kind: 'default' }
  }
}

function resolver(
  record: AgentSessionRecord,
  options: {
    launchEnv?: Record<string, string>
    inheritedEnv?: NodeJS.ProcessEnv
    base?: Record<string, string>
  } = {}
) {
  return createAcpStructuredLaunchResolver(OPENCODE, {
    store: { getRecord: () => record },
    readJournal: () => null,
    resolveWorkspacePath: async () => '/repo/worktree',
    resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user', ...options.base }),
    resolveLaunchEnv: () => options.launchEnv ?? {},
    resolveCommand: (command) => `/resolved/${command}`,
    inheritedEnv: options.inheritedEnv ?? {}
  })
}

describe('OpenCode ACP launch resolution', () => {
  it('runs `opencode acp` as an ACP client with no question tool, whatever the user set', async () => {
    const launch = await resolver(openCodeRecord(UNMANAGED), {
      launchEnv: { OPENCODE_CLIENT: 'tui', OPENCODE_ENABLE_QUESTION_TOOL: 'true' }
    })({ identity })
    expect(launch).toMatchObject({ command: '/resolved/opencode', args: ['acp'] })
    expect(launch.env).toMatchObject({
      OPENCODE_CLIENT: 'acp',
      OPENCODE_ENABLE_QUESTION_TOOL: 'false'
    })
  })

  it('pins the unmanaged data and state directories, and unsets a database it did not select', async () => {
    const launch = await resolver(openCodeRecord(UNMANAGED), {
      base: { XDG_DATA_HOME: '/elsewhere', OPENCODE_DB: '/elsewhere/other.db' },
      inheritedEnv: { OPENCODE_DB: '/elsewhere/other.db', OPENCODE_AUTH_CONTENT: '{"secret":1}' }
    })({ identity })
    expect(launch.env).toMatchObject({
      XDG_DATA_HOME: '/home/user/.local/share',
      XDG_STATE_HOME: '/home/user/.local/state'
    })
    expect(launch.env.OPENCODE_DB).toBeUndefined()
    const child = createProviderSpawnSpec(
      {
        command: launch.command,
        args: launch.args,
        env: launch.env,
        envToDelete: launch.envToDelete
      },
      { OPENCODE_DB: '/elsewhere/other.db', OPENCODE_AUTH_CONTENT: '{"secret":1}' },
      'darwin'
    ).env
    expect(child.OPENCODE_DB).toBeUndefined()
    expect(child.OPENCODE_AUTH_CONTENT).toBeUndefined()
  })

  it('points a managed profile at its own directories', async () => {
    const launch = await resolver(
      openCodeRecord({ kind: 'opencode', locator: { kind: 'managed', managedProfileId: PROFILE } })
    )({ identity })
    expect(launch.env).toMatchObject({
      XDG_DATA_HOME: `/profiles/${PROFILE}/data`,
      XDG_STATE_HOME: `/profiles/${PROFILE}/state`,
      OPENCODE_DB: 'opencode.db',
      OPENCODE_AUTH_CONTENT: ''
    })
  })

  it("restores the user's own config directory over Orca's status overlay", async () => {
    const inheritedEnv = {
      OPENCODE_CONFIG_DIR: '/orca/overlay',
      ORCA_OPENCODE_CONFIG_DIR: '/orca/overlay',
      ORCA_OPENCODE_SOURCE_CONFIG_DIR: '/home/user/.config/opencode-mine',
      ORCA_OPENCODE_AGENT: 'opencode'
    }
    const launch = await resolver(openCodeRecord(UNMANAGED), { inheritedEnv })({ identity })
    expect(launch.env.OPENCODE_CONFIG_DIR).toBe('/home/user/.config/opencode-mine')
    const child = createProviderSpawnSpec(
      {
        command: launch.command,
        args: launch.args,
        env: launch.env,
        envToDelete: [...ACP_CHILD_ENV_TO_DELETE, ...launch.envToDelete]
      },
      inheritedEnv,
      'darwin'
    ).env
    expect(Object.keys(child).filter((key) => key.startsWith('ORCA_OPENCODE_'))).toEqual([])
    expect(child.OPENCODE_CONFIG_DIR).toBe('/home/user/.config/opencode-mine')
  })

  it('drops an inherited overlay with no recorded source, so the default config is read', async () => {
    const inheritedEnv = {
      OPENCODE_CONFIG_DIR: '/orca/overlay',
      ORCA_OPENCODE_CONFIG_DIR: '/orca/overlay'
    }
    const launch = await resolver(openCodeRecord(UNMANAGED), { inheritedEnv })({ identity })
    const child = createProviderSpawnSpec(
      {
        command: launch.command,
        args: launch.args,
        env: launch.env,
        envToDelete: [...ACP_CHILD_ENV_TO_DELETE, ...launch.envToDelete]
      },
      inheritedEnv,
      'darwin'
    ).env
    expect(child.OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(child.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
  })

  it("keeps a config directory the user set for OpenCode's launches", async () => {
    const launch = await resolver(openCodeRecord(UNMANAGED), {
      launchEnv: { OPENCODE_CONFIG_DIR: '/home/user/team-config' },
      inheritedEnv: {
        OPENCODE_CONFIG_DIR: '/orca/overlay',
        ORCA_OPENCODE_CONFIG_DIR: '/orca/overlay'
      }
    })({ identity })
    expect(launch.env.OPENCODE_CONFIG_DIR).toBe('/home/user/team-config')
    expect(launch.envToDelete).not.toContain('OPENCODE_CONFIG_DIR')
  })

  it('refuses a record that pins a single directory instead of an OpenCode account', async () => {
    await expect(
      resolver(openCodeRecord({ variable: 'XDG_DATA_HOME', path: '/data' }))({ identity })
    ).rejects.toThrow(/pinned data account/)
  })
})

describe('OpenCode 2 over ACP: the chat runs under its own service account', () => {
  const baseEnvironment = async () => ({ HOME: '/home/user' })

  it('opens structured chats only while no managed profile is selected', async () => {
    activeAccountId = PROFILE
    expect(OPENCODE2_ACCOUNT.supportsCurrentSelection?.()).toBe(false)
    await expect(OPENCODE2_ACCOUNT.resolve({ launchEnv: {}, baseEnvironment })).rejects.toThrow(
      'structured_agent_session_unsupported'
    )
    activeAccountId = null
    expect(OPENCODE2_ACCOUNT.supportsCurrentSelection?.()).toBe(true)
    await expect(
      OPENCODE2_ACCOUNT.resolve({ launchEnv: {}, baseEnvironment })
    ).resolves.toMatchObject({
      kind: 'opencode',
      locator: { kind: 'unmanaged' }
    })
    activeAccountId = PROFILE
  })

  it('never launches a chat pinned to a managed profile', () => {
    expect(() =>
      OPENCODE2_ACCOUNT.environment(
        { kind: 'opencode', locator: { kind: 'managed', managedProfileId: PROFILE } },
        {}
      )
    ).toThrow(/service account/)
  })

  it('keeps managed profiles for OpenCode 1, whose ACP command runs the agent itself', () => {
    expect(OPENCODE.account.supportsCurrentSelection).toBeUndefined()
  })
})
