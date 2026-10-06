import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveProviderChildEnv } from '../../provider-process/provider-process-launch'
import { openCodeServerLaunch } from './server-launch'

const launchInput = {
  command: join('host', 'opencode'),
  cwd: join('workspace', 'folder'),
  environment: {},
  port: 48271,
  password: 'private-server-credential'
}

describe('OpenCode server launch', () => {
  it('binds an explicit loopback port in the workspace and pins both majors passwords', () => {
    const launch = openCodeServerLaunch(launchInput)
    expect(launch).toMatchObject({
      command: launchInput.command,
      cwd: launchInput.cwd,
      args: ['serve', '--hostname=127.0.0.1', '--port=48271'],
      env: {
        OPENCODE_SERVER_PASSWORD: launchInput.password,
        OPENCODE_PASSWORD: launchInput.password,
        OPENCODE_SERVER_USERNAME: 'opencode'
      }
    })
    expect(() => openCodeServerLaunch({ ...launchInput, port: 0 })).toThrow('explicit TCP port')
  })

  it('removes inherited status authority after overlay and restores the user config', () => {
    const source = join('account', 'config')
    const overlay = join('orca', 'terminal-config')
    const environment = {
      OPENCODE_CONFIG_DIR: overlay,
      ORCA_OPENCODE_CONFIG_DIR: overlay,
      ORCA_OPENCODE_SOURCE_CONFIG_DIR: source,
      ORCA_PANE_KEY: 'parent-pane',
      ORCA_AGENT_PANE: 'parent-alias',
      ORCA_AGENT_HOOK_ENDPOINT: 'parent-hook',
      ORCA_AGENT_LAUNCH: 'parent-launch',
      XDG_DATA_HOME: join('account', 'data'),
      XDG_STATE_HOME: join('account', 'state'),
      OPENCODE_AUTH_CONTENT: '',
      OPENCODE_DB: 'opencode.db'
    }
    const launch = openCodeServerLaunch({ ...launchInput, environment })
    const child = resolveProviderChildEnv(launch, environment)
    expect(child.OPENCODE_CONFIG_DIR).toBe(source)
    expect(child.XDG_DATA_HOME).toBe(environment.XDG_DATA_HOME)
    expect(child.XDG_STATE_HOME).toBe(environment.XDG_STATE_HOME)
    expect(child.OPENCODE_AUTH_CONTENT).toBe('')
    expect(child.OPENCODE_DB).toBe('opencode.db')
    for (const key of Object.keys(environment).filter((key) => key.startsWith('ORCA_'))) {
      expect(child[key]).toBeUndefined()
    }
    expect(environment.OPENCODE_CONFIG_DIR).toBe(overlay)
  })

  it('drops an overlay without a source and preserves explicit user config', () => {
    const overlay = join('orca', 'overlay')
    const environment = { OPENCODE_CONFIG_DIR: overlay, ORCA_OPENCODE_CONFIG_DIR: overlay }
    expect(
      resolveProviderChildEnv(openCodeServerLaunch({ ...launchInput, environment }), environment)
    ).not.toHaveProperty('OPENCODE_CONFIG_DIR')
    const explicit = { ...environment, OPENCODE_CONFIG_DIR: join('user', 'explicit') }
    expect(
      openCodeServerLaunch({ ...launchInput, environment: explicit }).env?.OPENCODE_CONFIG_DIR
    ).toBe(explicit.OPENCODE_CONFIG_DIR)
  })

  it('strips inherited caller identity and stamps only the owning chat', () => {
    const environment = {
      ORCA_TERMINAL_HANDLE: 'parent-terminal',
      ORCA_AGENT_SESSION_ID: 'parent-session',
      ORCA_STRUCTURED_SESSION: '1'
    }
    const anonymous = resolveProviderChildEnv(
      openCodeServerLaunch({ ...launchInput, environment }),
      environment
    )
    expect(anonymous).not.toHaveProperty('ORCA_TERMINAL_HANDLE')
    expect(anonymous).not.toHaveProperty('ORCA_AGENT_SESSION_ID')
    expect(anonymous).not.toHaveProperty('ORCA_STRUCTURED_SESSION')
    const owned = resolveProviderChildEnv(
      openCodeServerLaunch({ ...launchInput, environment, sessionId: 'owned-session' }),
      environment
    )
    expect(owned.ORCA_AGENT_SESSION_ID).toBe('owned-session')
    expect(owned.ORCA_STRUCTURED_SESSION).toBe('1')
    expect(owned).not.toHaveProperty('ORCA_TERMINAL_HANDLE')
  })
})
