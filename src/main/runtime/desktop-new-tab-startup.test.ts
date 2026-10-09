import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import {
  desktopNewTabPromptDelivery,
  type DesktopNewTabPromptTransport
} from '../../shared/desktop-new-tab-prompt'
import { buildRuntimeAgentTerminalStartupOptions } from './runtime-agent-terminal-startup'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'

const categories = ['claude', 'opencode', 'gemini', 'copilot', 'hermes', 'aider'] as const
const modes = ['auto-submit', 'draft', 'submit-after-ready'] as const
const hosts: {
  label: string
  platform: NodeJS.Platform
  shell?: string
  connectionId: string | null
}[] = [
  { label: 'macOS', platform: 'darwin', connectionId: null },
  { label: 'Windows PowerShell', platform: 'win32', shell: 'powershell.exe', connectionId: null },
  { label: 'Windows cmd', platform: 'win32', shell: 'cmd.exe', connectionId: null },
  {
    label: 'WSL Linux command on Windows transport',
    platform: 'linux',
    shell: 'wsl.exe',
    connectionId: null
  },
  { label: 'SSH Linux', platform: 'linux', shell: 'cmd.exe', connectionId: 'ssh-linux' },
  { label: 'SSH Windows', platform: 'win32', shell: 'cmd.exe', connectionId: 'ssh-windows' }
]

function settingsFor(agent: TuiAgent) {
  return {
    ...getDefaultSettings('/test-desktop-home'),
    disabledTuiAgents: [],
    agentDefaultArgs: { [agent]: '--test-argument' },
    agentDefaultEnv: { [agent]: { DESKTOP_TEST_ENV: "a'b\nUnicode 🦄" } }
  }
}

async function compareMainInputs(args: {
  agent: TuiAgent
  mode: DesktopNewTabPromptTransport['promptDelivery']
  text: string
  host: (typeof hosts)[number]
  agentArgs?: string | null
  command?: string
}) {
  const settings = {
    ...settingsFor(args.agent),
    terminalWindowsShell: args.host.shell,
    ...(args.command ? { agentCmdOverrides: { [args.agent]: args.command } } : {})
  }
  const workspace: TerminalWorkspaceLaunchScope = {
    id: 'folder-workspace:test',
    path: '/workspace/app',
    connectionId: args.host.connectionId,
    repo: null,
    folderWorkspace: null
  }
  // Inputs read first-hand at origin/main 42a40f861d4, launch-agent-in-new-tab.ts:140-175.
  const base = {
    agent: args.agent,
    cmdOverrides: settings.agentCmdOverrides ?? {},
    platform: args.host.platform,
    shell: resolveLocalWindowsAgentStartupShell({
      platform: args.host.platform,
      isRemote: Boolean(args.host.connectionId),
      terminalWindowsShell: args.host.shell
    }),
    isRemote: Boolean(args.host.connectionId),
    agentArgs:
      args.agentArgs !== undefined
        ? args.agentArgs
        : resolveTuiAgentLaunchArgs(args.agent, settings.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(args.agent, settings.agentDefaultEnv)
  }
  const text = args.text.trim()
  const empty = () => buildAgentStartupPlan({ ...base, prompt: '', allowEmptyPromptLaunch: true })
  const nativeDraft =
    text && args.mode === 'draft' ? buildAgentDraftLaunchPlan({ ...base, draft: text }) : null
  const expected =
    nativeDraft ??
    (text &&
    args.mode === 'auto-submit' &&
    TUI_AGENT_CONFIG[args.agent].promptInjectionMode !== 'stdin-after-start'
      ? buildAgentStartupPlan({ ...base, prompt: text })
      : empty())
  const carry = vi.fn()
  const operation = buildRuntimeAgentTerminalStartupOptions(
    workspace,
    {
      startupAgent: args.agent,
      desktopPrompt: {
        text: args.text,
        delivery: desktopNewTabPromptDelivery(args.agent, args.mode),
        transport: { kind: 'desktop-new-tab', promptDelivery: args.mode }
      },
      ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}),
      onStartupPromptCarry: carry
    },
    settings,
    args.host.platform,
    undefined,
    'test-host'
  )
  if (!expected) {
    await expect(operation).rejects.toThrow(`Could not build launch command for ${args.agent}`)
    expect(carry).not.toHaveBeenCalled()
    return
  }
  const actual = await operation
  expect({
    command: actual.command,
    env: actual.env,
    launchConfig: actual.launchConfig,
    startupCommandDelivery: actual.startupCommandDelivery
  }).toEqual({
    command: expected.launchCommand,
    env: expected.env,
    launchConfig: expected.launchConfig,
    startupCommandDelivery: expected.startupCommandDelivery
  })
  expect(carry).toHaveBeenCalledExactlyOnceWith(
    Boolean(text) &&
      Boolean(
        nativeDraft ||
        (args.mode === 'auto-submit' &&
          TUI_AGENT_CONFIG[args.agent].promptInjectionMode !== 'stdin-after-start')
      )
  )
  return actual
}

describe('desktop startup keeps named main planner inputs', () => {
  for (const host of hosts) {
    for (const agent of categories) {
      for (const mode of modes) {
        it(`${host.label}: ${agent} ${mode} preserves command, env, resume config and shell delivery`, async () => {
          await compareMainInputs({
            host,
            agent,
            mode,
            text: `First 'quoted' 🦄\nLF\r\nCRLF\rCR\x1b literal ${'x'.repeat(700)}`
          })
        })
      }
    }
  }
  for (const text of ['', ' \n\r\t ']) {
    for (const mode of modes) {
      it(`empty/whitespace ${JSON.stringify(text)} with ${mode} starts without input`, async () => {
        await compareMainInputs({ host: hosts[0], agent: 'claude', mode, text })
      })
    }
  }
  for (const agent of ['claude', 'openclaude', 'pi', 'omp'] as const) {
    it(`${agent} retains native prefill and environment cleanup`, async () => {
      for (const host of hosts) {
        await compareMainInputs({ host, agent, mode: 'draft', text: "Draft '🦄'\nsecond" })
      }
    })
    it(`${agent} falls back to an empty startup when Windows native prefill refuses size`, async () => {
      const plan = await compareMainInputs({
        host: hosts[1],
        agent,
        mode: 'draft',
        text: 'x'.repeat(30_000)
      })
      expect(plan?.command).not.toContain('x'.repeat(100))
      expect(plan?.env).not.toHaveProperty('ORCA_PI_PREFILL')
      expect(plan?.env).not.toHaveProperty('ORCA_OMP_PREFILL')
    })
  }
  for (const agentArgs of [undefined, null, '--model sonnet --effort low']) {
    it(`argument precedence and tri-state override ${String(agentArgs)}`, async () => {
      await compareMainInputs({
        host: hosts[0],
        agent: 'claude',
        mode: 'auto-submit',
        text: 'hello',
        agentArgs,
        command: 'claude --model haiku'
      })
    })
  }
  it('OpenCode preserves a custom run command and startup environment without host model rewriting', async () => {
    await compareMainInputs({
      host: hosts[0],
      agent: 'opencode',
      mode: 'auto-submit',
      text: 'hello',
      command: 'opencode run --model custom/provider'
    })
  })
  it('Hermes refuses an oversize automatic native query rather than silently changing to paste', async () => {
    await compareMainInputs({
      host: hosts[0],
      agent: 'hermes',
      mode: 'auto-submit',
      text: 'x'.repeat(30_000)
    })
  })
})
