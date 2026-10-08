import { describe, expect, it, vi } from 'vitest'
import * as loginShell from '../startup/login-shell-environment'
import * as windowsPath from '../pty/windows-environment-path'
import {
  createStructuredAgentEnvironmentResolvers,
  structuredAgentBaseEnvironment
} from './structured-agent-shell-environment'

const INHERIT_ALL = { inheritAll: true, names: [] }

const shellEnv = {
  PATH: '/shell/bin',
  LANG: 'en_US.UTF-8',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
  CODEX_LB_API_KEY: 'lb-key',
  ANTHROPIC_API_KEY: 'shell-key',
  CLAUDE_CONFIG_DIR: '/shell/claude',
  UNSET: undefined
}

const processEnv = { PATH: '/orca/bin', HOME: '/home/me', ORCA_USER_DATA_PATH: '/orca' }

describe('structuredAgentBaseEnvironment', () => {
  it('is the whole shell snapshot, and nothing else, when inheriting all', () => {
    expect(
      structuredAgentBaseEnvironment({
        shellEnv,
        policy: INHERIT_ALL,
        processEnv,
        platform: 'darwin'
      })
    ).toEqual({
      PATH: '/shell/bin',
      LANG: 'en_US.UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      CODEX_LB_API_KEY: 'lb-key',
      ANTHROPIC_API_KEY: 'shell-key',
      CLAUDE_CONFIG_DIR: '/shell/claude'
    })
  })

  it('passes only the baseline and listed shell names over Orca env when off', () => {
    expect(
      structuredAgentBaseEnvironment({
        shellEnv,
        policy: { inheritAll: false, names: ['CODEX_LB_API_KEY'] },
        processEnv,
        platform: 'darwin'
      })
    ).toEqual({
      PATH: '/shell/bin',
      HOME: '/home/me',
      ORCA_USER_DATA_PATH: '/orca',
      LANG: 'en_US.UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      CODEX_LB_API_KEY: 'lb-key'
    })
  })

  it('matches names case-insensitively on Windows without duplicating Path', () => {
    expect(
      structuredAgentBaseEnvironment({
        shellEnv: { PATH: 'C:\\shell', codex_lb_api_key: 'lb-key' },
        policy: { inheritAll: false, names: ['CODEX_LB_API_KEY'] },
        processEnv: { Path: 'C:\\orca', USERPROFILE: 'C:\\Users\\me' },
        platform: 'win32'
      })
    ).toEqual({ PATH: 'C:\\shell', USERPROFILE: 'C:\\Users\\me', codex_lb_api_key: 'lb-key' })
  })
})

describe('createStructuredAgentEnvironmentResolvers', () => {
  it('refreshes the saved Windows PATH before capturing the configured shell', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const registry = vi
      .spyOn(windowsPath, 'mergePersistedWindowsPathAsync')
      .mockImplementation(async (env) => {
        env.PATH = 'C:\\new-cli'
      })
    const capture = vi
      .spyOn(loginShell, 'resolveLoginShellEnvironment')
      .mockImplementation(async (options) => options?.env ?? {})
    try {
      const resolvers = createStructuredAgentEnvironmentResolvers({
        resolveShellEnvironmentPolicy: () => INHERIT_ALL
      })
      expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('C:\\new-cli')
      expect(registry).toHaveBeenCalledWith(expect.any(Object), { forceRefresh: true })
      expect(capture).toHaveBeenCalledWith({
        force: true,
        env: expect.objectContaining({ PATH: 'C:\\new-cli' })
      })
    } finally {
      registry.mockRestore()
      capture.mockRestore()
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('bypasses the login-shell cache on every settled acquisition', async () => {
    const capture = vi
      .spyOn(loginShell, 'resolveLoginShellEnvironment')
      .mockResolvedValue({ PATH: '/shell/current' })
    try {
      const resolvers = createStructuredAgentEnvironmentResolvers({})
      await resolvers.resolveBaseEnvironment()
      await resolvers.resolveClaudeInheritedEnv()
      expect(capture).toHaveBeenCalledTimes(2)
      expect(capture).toHaveBeenCalledWith(expect.objectContaining({ force: true }))
    } finally {
      capture.mockRestore()
    }
  })

  it('shares concurrent captures and retries after a failed capture', async () => {
    let release: (env: NodeJS.ProcessEnv) => void = () => {}
    const capture = vi.fn(
      () =>
        new Promise<NodeJS.ProcessEnv>((resolve) => {
          release = resolve
        })
    )
    const resolvers = createStructuredAgentEnvironmentResolvers({ resolveEnvironment: capture })
    const first = resolvers.resolveBaseEnvironment()
    const second = resolvers.resolveClaudeInheritedEnv()
    expect(capture).toHaveBeenCalledOnce()
    release({ PATH: '/first' })
    await Promise.all([first, second])
    capture.mockRejectedValueOnce(new Error('shell failed'))
    await expect(resolvers.resolveBaseEnvironment()).rejects.toThrow('shell failed')
    capture.mockResolvedValueOnce({ PATH: '/repaired' })
    expect((await resolvers.resolveBaseEnvironment()).PATH).toBe('/repaired')
    expect(capture).toHaveBeenCalledTimes(3)
  })

  it('refreshes the shell PATH for later acquisitions while rereading settings', async () => {
    let shellPath = '/shell/A'
    let overlay = 'A'
    const resolveEnvironment = vi.fn(async () => ({ PATH: shellPath }))
    const resolvers = createStructuredAgentEnvironmentResolvers({
      resolveEnvironment,
      resolveShellEnvironmentPolicy: () => INHERIT_ALL,
      resolveLaunchEnvOverlay: () => ({ CURRENT_SETTING: overlay })
    })
    expect(await resolvers.resolveCodexEnvironment()).toEqual({
      PATH: '/shell/A',
      CURRENT_SETTING: 'A'
    })
    shellPath = '/shell/B'
    overlay = 'B'
    expect(await resolvers.resolveBaseEnvironment()).toEqual({ PATH: '/shell/B' })
    expect(await resolvers.resolveClaudeInheritedEnv()).toEqual({ PATH: '/shell/B' })
    expect(await resolvers.resolveCodexEnvironment()).toEqual({
      PATH: '/shell/B',
      CURRENT_SETTING: 'B'
    })
    expect(resolveEnvironment).toHaveBeenCalledTimes(4)
  })

  it('gives Codex and Claude the same base, with overlays on Codex only', async () => {
    const resolvers = createStructuredAgentEnvironmentResolvers({
      resolveEnvironment: async () => ({ PATH: '/shell/bin', SHELL_ONLY: '1' }),
      resolveShellEnvironmentPolicy: () => INHERIT_ALL,
      resolveCodexOverrides: () => ({ CODEX_PROFILE: 'p' })
    })
    expect(await resolvers.resolveClaudeInheritedEnv()).toEqual({
      PATH: '/shell/bin',
      SHELL_ONLY: '1'
    })
    expect(await resolvers.resolveCodexEnvironment()).toEqual({
      PATH: '/shell/bin',
      SHELL_ONLY: '1',
      CODEX_PROFILE: 'p'
    })
  })
})
