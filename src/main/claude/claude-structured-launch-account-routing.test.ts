import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import {
  CLAUDE_PROFILE_MISSING_MESSAGE,
  ClaudeProfileRouter,
  type ClaudeProfileRouterSettings
} from '../claude-accounts/claude-profile-router'
import { installClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'

const roots: string[] = []
afterEach(() => {
  installClaudeProfileRouter(undefined)
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

it('launches each acquisition under the current selection, not the account it was created under', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-launch-routing-'))
  roots.push(root)
  const settings: ClaudeProfileRouterSettings = {
    claudeManagedAccounts: [],
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: undefined,
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const router = new ClaudeProfileRouter({
    getSettings: () => settings,
    dataRoot: root,
    userHome: join(root, 'personal'),
    env: { CLAUDE_CONFIG_DIR: '/user/own' }
  })
  installClaudeProfileRouter(router)
  const record = {
    ...agentSessionRecordFixture(),
    providerHandleChain: [],
    accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/created/under/b' }
  }
  const resolve = createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record },
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => '/usr/local/bin/claude',
    resolveInheritedEnv: async () => ({ PATH: '/usr/bin' }),
    resolveAuthPolicy: () => ({ stripAuthEnv: false })
  })
  const identity = {
    sessionId: record.sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'claude' as const,
    providerHandle: { kind: 'claude' as const, sessionId: 'unused', leafUuid: null }
  }

  await expect(resolve({ identity })).rejects.toThrow(CLAUDE_PROFILE_MISSING_MESSAGE)

  const home = join(root, 'claude-profiles', 'a', 'home')
  mkdirSync(home, { recursive: true })
  const routed = await resolve({ identity })
  expect(routed.claudeConfigDir).toBe(home)
  expect(routed.env).toMatchObject({
    CLAUDE_CONFIG_DIR: home,
    ORCA_CLAUDE_INJECTED_CONFIG_DIR: home
  })

  settings.activeClaudeManagedAccountId = null
  expect((await resolve({ identity })).claudeConfigDir).toBe('/user/own')
})
