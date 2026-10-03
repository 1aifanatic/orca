import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setAppEnvironment } from '../../shared/app-environment'
import {
  createOpenCodeStartupPromptInstaller,
  installOpenCodeStartupPromptForLaunch
} from './opencode-startup-prompt-installer'

let root: string
let originalXdg: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opencode-prompt-install-'))
  originalXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(root, 'config')
  setAppEnvironment({
    getPath: () => join(root, 'profile'),
    getAppPath: () => root,
    getVersion: () => 'test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
})
afterEach(() => {
  if (originalXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdg
  }
  rmSync(root, { recursive: true, force: true })
})
describe('OpenCode startup prompt installer', () => {
  it('keeps a missing user config untouched and installs the launch into an owned overlay', () => {
    const source = join(root, 'missing-user-config')
    const env: Record<string, string> = {
      ORCA_OPENCODE_PLUGIN_API: 'v2',
      ORCA_OPENCODE_STARTUP_PROMPT_NONCE: 'private-launch',
      OPENCODE_CONFIG_DIR: source,
      OPENCODE_CONFIG_CONTENT: '{"model":"opencode/model"}'
    }
    installOpenCodeStartupPromptForLaunch(env)
    expect(existsSync(source)).toBe(false)
    expect(env.OPENCODE_CONFIG_DIR).toContain(
      join(root, 'profile', 'opencode-startup-prompt-overlays')
    )
    expect(env.ORCA_OPENCODE_CONFIG_DIR).toBe(env.OPENCODE_CONFIG_DIR)
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"model":"opencode/model"}')
    expect(
      existsSync(join(env.OPENCODE_CONFIG_DIR, 'plugins', 'orca-opencode-startup-prompt', 'tui.js'))
    ).toBe(true)
    expect(existsSync(join(env.OPENCODE_CONFIG_DIR, 'plugins', 'orca-opencode-status.js'))).toBe(
      false
    )
  })
  it('installs only a TUI entry without installing status hooks or a v1/server entry', () => {
    const service = createOpenCodeStartupPromptInstaller(() => 'prompt source')
    expect(service.buildPtyEnv('pane')).toEqual({})
    const plugins = join(root, 'config', 'opencode', 'plugins')
    expect(readFileSync(join(plugins, 'orca-opencode-startup-prompt', 'tui.js'), 'utf8')).toBe(
      'prompt source'
    )
    expect(existsSync(join(plugins, 'orca-opencode-startup-prompt.js'))).toBe(false)
    expect(existsSync(join(plugins, 'orca-opencode-status.js'))).toBe(false)
    expect(existsSync(join(root, 'profile', 'opencode-startup-prompt-hooks'))).toBe(false)
  })
  it('preserves user config and plugins across source-scoped overlay refreshes', () => {
    const config = join(root, 'custom')
    mkdirSync(join(config, 'plugins'), { recursive: true })
    writeFileSync(join(config, 'opencode.json'), '{"model":"user/model"}')
    writeFileSync(join(config, 'plugins', 'user.js'), 'user source')
    mkdirSync(join(config, 'plugins', 'orca-opencode-startup-prompt'))
    writeFileSync(
      join(config, 'plugins', 'orca-opencode-startup-prompt', 'tui.js'),
      'user collision'
    )
    let source = 'first prompt source'
    const service = createOpenCodeStartupPromptInstaller(() => source)
    const first = service.buildPtyEnv('pane-a', config).OPENCODE_CONFIG_DIR
    expect(first).toBeDefined()
    source = 'next prompt source'
    expect(service.buildPtyEnv('pane-b', config).OPENCODE_CONFIG_DIR).toBe(first)
    if (!first) {
      throw new Error('Missing overlay')
    }
    expect(
      readFileSync(join(first, 'plugins', 'orca-opencode-startup-prompt', 'tui.js'), 'utf8')
    ).toBe(source)
    expect(readFileSync(join(first, 'opencode.json'), 'utf8')).toContain('user/model')
    expect(readFileSync(join(first, 'plugins', 'user.js'), 'utf8')).toBe('user source')
    expect(
      readFileSync(join(config, 'plugins', 'orca-opencode-startup-prompt', 'tui.js'), 'utf8')
    ).toBe('user collision')
  })
})
