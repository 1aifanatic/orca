import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  NATIVE_CHAT_VISUALS_DIR_ENV,
  type NativeChatVisualsLaunch
} from '../native-chat/native-chat-visuals-delivery'
import { CLAUDE_PLUGIN_DIR_FLAG, type ClaudeCliFlag } from './claude-cli-flag-support'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'

const SESSION_ID = 'orca-session-visuals'
const VISUALS: NativeChatVisualsLaunch = {
  folder: '/state/native-chat-visuals/abc',
  skill: { pluginDir: '/app/native-chat-visuals', skillsRoot: '/app/native-chat-visuals/skills' }
}

const record = {
  sessionId: SESSION_ID,
  provider: 'claude',
  location: {
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'folder'
  },
  accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/work/.claude' },
  providerHandleChain: []
} as unknown as AgentSessionRecord

function launch(options: {
  prepareVisuals?: (sessionId: string) => Promise<NativeChatVisualsLaunch | null>
  supports?: (flag: ClaudeCliFlag) => Promise<boolean>
  launchArgs?: string[]
  env?: Record<string, string>
}) {
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => '/usr/local/bin/claude',
    resolveAuthPolicy: () => ({ stripAuthEnv: false }),
    resolveLaunchArgs: () => options.launchArgs ?? [],
    resolveEnv: () => options.env ?? {},
    hasTranscript: async () => false,
    ...(options.supports ? { cliFlags: { supports: options.supports } } : {}),
    ...(options.prepareVisuals ? { prepareVisuals: options.prepareVisuals } : {})
  })({
    identity: { sessionId: SESSION_ID } as Parameters<
      ReturnType<typeof createClaudeStructuredLaunchResolver>
    >[0]['identity']
  })
}

describe('a Claude chat launch with inline visuals', () => {
  it('loads the skill plugin, grants the chat folder beside the user directories, and names it', async () => {
    const prepareVisuals = vi.fn(async () => VISUALS)
    const resolved = await launch({
      prepareVisuals,
      supports: async (flag) => flag === CLAUDE_PLUGIN_DIR_FLAG,
      launchArgs: ['--add-dir', '/shared/notes']
    })
    expect(prepareVisuals).toHaveBeenCalledWith(SESSION_ID)
    expect(resolved.options.plugins).toEqual([{ type: 'local', path: VISUALS.skill.pluginDir }])
    expect(resolved.options.additionalDirectories).toEqual(['/shared/notes', VISUALS.folder])
    expect(resolved.env?.[NATIVE_CHAT_VISUALS_DIR_ENV]).toBe(VISUALS.folder)
  })

  it('still grants and names the folder when the CLI cannot load a plugin by path', async () => {
    const resolved = await launch({
      prepareVisuals: async () => VISUALS,
      supports: async () => false
    })
    expect(resolved.options).not.toHaveProperty('plugins')
    expect(resolved.options.additionalDirectories).toEqual([VISUALS.folder])
    expect(resolved.env?.[NATIVE_CHAT_VISUALS_DIR_ENV]).toBe(VISUALS.folder)
  })

  it('without a prepared folder, grants nothing and drops a folder inherited from another chat', async () => {
    const resolved = await launch({
      prepareVisuals: async () => null,
      supports: async () => true,
      env: { [NATIVE_CHAT_VISUALS_DIR_ENV]: '/state/native-chat-visuals/other-chat' }
    })
    expect(resolved.options).not.toHaveProperty('plugins')
    expect(resolved.options).not.toHaveProperty('additionalDirectories')
    expect(resolved.env).not.toHaveProperty(NATIVE_CHAT_VISUALS_DIR_ENV)
  })

  it('never asks about the plugin flag on a host that delivers no visuals', async () => {
    const supports = vi.fn(async (_flag: ClaudeCliFlag) => true)
    const resolved = await launch({ supports })
    expect(supports.mock.calls.map(([flag]) => flag)).not.toContain(CLAUDE_PLUGIN_DIR_FLAG)
    expect(resolved.options).not.toHaveProperty('plugins')
  })
})
